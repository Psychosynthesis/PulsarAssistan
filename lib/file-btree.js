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

// src/file-btree.ts
var file_btree_exports = {};
__export(file_btree_exports, {
  BTree: () => BTree,
  BTreeNode: () => BTreeNode,
  DEFAULT_PROJECT_SKIP_DIRS: () => DEFAULT_PROJECT_SKIP_DIRS,
  ProjectFileTree: () => ProjectFileTree,
  toPosixPath: () => toPosixPath
});
module.exports = __toCommonJS(file_btree_exports);
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));

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

// src/file-btree.ts
var DEFAULT_PROJECT_SKIP_DIRS = buildIgnoredDirsSet();
function toPosixPath(relPath) {
  return relPath.split(path.sep).join("/");
}
var BTreeNode = class _BTreeNode {
  constructor(leaf = true) {
    this.leaf = leaf;
    this.keys = [];
    this.values = [];
    this.children = [];
  }
  toJSON() {
    const out = {
      leaf: this.leaf,
      keys: this.keys,
      values: this.values
    };
    if (!this.leaf && this.children.length > 0) {
      out.children = this.children.map((c) => c.toJSON());
    }
    return out;
  }
  static fromJSON(json) {
    const node = new _BTreeNode(json.leaf);
    node.keys = [...json.keys];
    node.values = json.values.map((v) => {
      if (v && typeof v === "object" && "path" in v) {
        const { path: _p, ...rest } = v;
        return rest;
      }
      return v;
    });
    if (json.children) {
      node.children = json.children.map((c) => _BTreeNode.fromJSON(c));
    }
    return node;
  }
};
var BTree = class {
  constructor(degree = 16) {
    this._size = 0;
    if (degree < 2) throw new Error("Degree t must be >= 2");
    this.t = degree;
    this.root = new BTreeNode(true);
  }
  size() {
    return this._size;
  }
  search(key) {
    return this._searchNode(this.root, key);
  }
  _searchNode(node, key) {
    let i = 0;
    while (i < node.keys.length && key > node.keys[i]) {
      i++;
    }
    if (i < node.keys.length && key === node.keys[i]) {
      return node.values[i];
    }
    if (node.leaf) {
      return null;
    }
    return this._searchNode(node.children[i], key);
  }
  insert(key, value) {
    const existing = this.search(key);
    if (existing !== null) {
      this._updateNode(this.root, key, value);
      return;
    }
    const r = this.root;
    if (r.keys.length === 2 * this.t - 1) {
      const s = new BTreeNode(false);
      this.root = s;
      s.children.push(r);
      this._splitChild(s, 0, r);
      this._insertNonFull(s, key, value);
    } else {
      this._insertNonFull(r, key, value);
    }
    this._size++;
  }
  _updateNode(node, key, value) {
    let i = 0;
    while (i < node.keys.length && key > node.keys[i]) {
      i++;
    }
    if (i < node.keys.length && key === node.keys[i]) {
      node.values[i] = value;
      return;
    }
    if (!node.leaf) {
      this._updateNode(node.children[i], key, value);
    }
  }
  _insertNonFull(node, key, value) {
    let i = node.keys.length - 1;
    if (node.leaf) {
      while (i >= 0 && key < node.keys[i]) {
        i--;
      }
      node.keys.splice(i + 1, 0, key);
      node.values.splice(i + 1, 0, value);
    } else {
      while (i >= 0 && key < node.keys[i]) {
        i--;
      }
      i++;
      if (node.children[i].keys.length === 2 * this.t - 1) {
        this._splitChild(node, i, node.children[i]);
        if (key > node.keys[i]) {
          i++;
        }
      }
      this._insertNonFull(node.children[i], key, value);
    }
  }
  _splitChild(parent, i, child) {
    const t = this.t;
    const z = new BTreeNode(child.leaf);
    z.keys = child.keys.splice(t);
    z.values = child.values.splice(t);
    const midKey = child.keys.pop();
    const midVal = child.values.pop();
    if (!child.leaf) {
      z.children = child.children.splice(t);
    }
    parent.children.splice(i + 1, 0, z);
    parent.keys.splice(i, 0, midKey);
    parent.values.splice(i, 0, midVal);
  }
  delete(key) {
    const deleted = this._deleteNode(this.root, key);
    if (deleted) {
      this._size--;
      if (this.root.keys.length === 0 && !this.root.leaf) {
        this.root = this.root.children[0];
      }
    }
    return deleted;
  }
  _deleteNode(node, key) {
    const t = this.t;
    let idx = 0;
    while (idx < node.keys.length && node.keys[idx] < key) {
      idx++;
    }
    if (idx < node.keys.length && node.keys[idx] === key) {
      if (node.leaf) {
        node.keys.splice(idx, 1);
        node.values.splice(idx, 1);
        return true;
      }
      return this._deleteInternalNode(node, idx);
    }
    if (node.leaf) {
      return false;
    }
    const isLastChild = idx === node.keys.length;
    if (node.children[idx].keys.length < t) {
      this._fill(node, idx);
    }
    if (isLastChild && idx > node.keys.length) {
      return this._deleteNode(node.children[idx - 1], key);
    } else {
      return this._deleteNode(node.children[idx], key);
    }
  }
  _deleteInternalNode(node, idx) {
    const k = node.keys[idx];
    const t = this.t;
    if (node.children[idx].keys.length >= t) {
      const { key: predKey, val: predVal } = this._getPred(node, idx);
      node.keys[idx] = predKey;
      node.values[idx] = predVal;
      return this._deleteNode(node.children[idx], predKey);
    } else if (node.children[idx + 1].keys.length >= t) {
      const { key: succKey, val: succVal } = this._getSucc(node, idx);
      node.keys[idx] = succKey;
      node.values[idx] = succVal;
      return this._deleteNode(node.children[idx + 1], succKey);
    } else {
      this._merge(node, idx);
      return this._deleteNode(node.children[idx], k);
    }
  }
  _getPred(node, idx) {
    let curr = node.children[idx];
    while (!curr.leaf) {
      curr = curr.children[curr.children.length - 1];
    }
    return {
      key: curr.keys[curr.keys.length - 1],
      val: curr.values[curr.values.length - 1]
    };
  }
  _getSucc(node, idx) {
    let curr = node.children[idx + 1];
    while (!curr.leaf) {
      curr = curr.children[0];
    }
    return { key: curr.keys[0], val: curr.values[0] };
  }
  _fill(node, idx) {
    const t = this.t;
    if (idx !== 0 && node.children[idx - 1].keys.length >= t) {
      this._borrowFromPrev(node, idx);
    } else if (idx !== node.keys.length && node.children[idx + 1].keys.length >= t) {
      this._borrowFromNext(node, idx);
    } else {
      if (idx !== node.keys.length) {
        this._merge(node, idx);
      } else {
        this._merge(node, idx - 1);
      }
    }
  }
  _borrowFromPrev(node, idx) {
    const child = node.children[idx];
    const sibling = node.children[idx - 1];
    child.keys.unshift(node.keys[idx - 1]);
    child.values.unshift(node.values[idx - 1]);
    if (!child.leaf) {
      child.children.unshift(sibling.children.pop());
    }
    node.keys[idx - 1] = sibling.keys.pop();
    node.values[idx - 1] = sibling.values.pop();
  }
  _borrowFromNext(node, idx) {
    const child = node.children[idx];
    const sibling = node.children[idx + 1];
    child.keys.push(node.keys[idx]);
    child.values.push(node.values[idx]);
    if (!child.leaf) {
      child.children.push(sibling.children.shift());
    }
    node.keys[idx] = sibling.keys.shift();
    node.values[idx] = sibling.values.shift();
  }
  _merge(node, idx) {
    const child = node.children[idx];
    const sibling = node.children[idx + 1];
    child.keys.push(node.keys[idx]);
    child.values.push(node.values[idx]);
    child.keys.push(...sibling.keys);
    child.values.push(...sibling.values);
    if (!child.leaf) {
      child.children.push(...sibling.children);
    }
    node.keys.splice(idx, 1);
    node.values.splice(idx, 1);
    node.children.splice(idx + 1, 1);
  }
  keys() {
    const res = [];
    this._traverseKeys(this.root, res);
    return res;
  }
  _traverseKeys(node, res) {
    for (let i = 0; i < node.keys.length; i++) {
      if (!node.leaf) {
        this._traverseKeys(node.children[i], res);
      }
      res.push(node.keys[i]);
    }
    if (!node.leaf) {
      this._traverseKeys(node.children[node.keys.length], res);
    }
  }
  entries() {
    const res = [];
    this._traverseEntries(this.root, res);
    return res;
  }
  _traverseEntries(node, res) {
    for (let i = 0; i < node.keys.length; i++) {
      if (!node.leaf) {
        this._traverseEntries(node.children[i], res);
      }
      res.push({ key: node.keys[i], value: node.values[i] });
    }
    if (!node.leaf) {
      this._traverseEntries(node.children[node.keys.length], res);
    }
  }
  prefixSearch(prefix) {
    const res = [];
    this._prefixSearchNode(this.root, prefix, res);
    return res;
  }
  _prefixSearchNode(node, prefix, res) {
    for (let i = 0; i < node.keys.length; i++) {
      const k = node.keys[i];
      if (!node.leaf && k >= prefix) {
        this._prefixSearchNode(node.children[i], prefix, res);
      }
      if (k.startsWith(prefix)) {
        res.push({ key: k, value: node.values[i] });
      }
    }
    if (!node.leaf) {
      this._prefixSearchNode(node.children[node.keys.length], prefix, res);
    }
  }
  recalculateSize() {
    let count = 0;
    const walk = (node) => {
      count += node.keys.length;
      if (!node.leaf) {
        for (const child of node.children) {
          walk(child);
        }
      }
    };
    walk(this.root);
    this._size = count;
    return count;
  }
};
var ProjectFileTree = class _ProjectFileTree {
  constructor(projectRoot, degree = 16) {
    this.projectRoot = path.resolve(projectRoot);
    this.updatedAt = Date.now();
    this.tree = new BTree(degree);
  }
  get size() {
    return this.tree.size();
  }
  get degree() {
    return this.tree.t;
  }
  has(posixRelPath) {
    return this.tree.search(posixRelPath) !== null;
  }
  get(posixRelPath) {
    const val = this.tree.search(posixRelPath);
    if (!val) return null;
    return {
      path: posixRelPath,
      size: val.size,
      mtime: val.mtime,
      isDirectory: val.isDirectory
    };
  }
  set(posixRelPath, meta) {
    this.tree.insert(posixRelPath, {
      size: meta.size,
      mtime: meta.mtime,
      isDirectory: meta.isDirectory
    });
    this.updatedAt = Date.now();
  }
  remove(posixRelPath) {
    const res = this.tree.delete(posixRelPath);
    if (res) this.updatedAt = Date.now();
    return res;
  }
  listPaths() {
    return this.tree.keys();
  }
  listAll() {
    return this.tree.entries().map((e) => ({
      path: e.key,
      size: e.value.size,
      mtime: e.value.mtime,
      isDirectory: e.value.isDirectory
    }));
  }
  findInDirectory(subDir) {
    let normalized = toPosixPath(subDir).replace(/^\.\/?/, "");
    if (normalized && !normalized.endsWith("/")) {
      normalized += "/";
    }
    const entries = this.tree.prefixSearch(normalized);
    return entries.map((e) => ({
      path: e.key,
      size: e.value.size,
      mtime: e.value.mtime,
      isDirectory: e.value.isDirectory
    }));
  }
  async scanProject(skipDirs = getConfiguredIgnoredDirs()) {
    const newTree = new BTree(this.tree.t);
    const stack = [
      { dir: this.projectRoot, relative: "" }
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
        if (skipDirs.has(entry.name)) continue;
        const relPath = current.relative ? `${current.relative}/${entry.name}` : entry.name;
        const fullPath = path.join(current.dir, entry.name);
        if (entry.isDirectory()) {
          stack.push({ dir: fullPath, relative: relPath });
          continue;
        }
        if (entry.isFile()) {
          try {
            const stat = await fs.promises.stat(fullPath);
            newTree.insert(relPath, {
              size: stat.size,
              mtime: stat.mtimeMs,
              isDirectory: false
            });
          } catch {
          }
        }
      }
    }
    this.tree = newTree;
    this.updatedAt = Date.now();
  }
  async updatePath(fullOrRelPath) {
    const fullPath = path.isAbsolute(fullOrRelPath) ? fullOrRelPath : path.join(this.projectRoot, fullOrRelPath);
    const relPath = toPosixPath(path.relative(this.projectRoot, fullPath));
    try {
      const stat = await fs.promises.stat(fullPath);
      this.set(relPath, {
        size: stat.size,
        mtime: stat.mtimeMs,
        isDirectory: stat.isDirectory()
      });
    } catch (err) {
      if (err.code === "ENOENT") {
        this.remove(relPath);
      }
    }
  }
  toHierarchyText(maxLines = 300, startPath = ".", maxDepth = 5) {
    const all = this.listAll();
    if (all.length === 0) return "(empty project)";
    const normalizedStart = startPath ? toPosixPath(startPath).replace(/^\.\/?/, "").replace(/\/+$/, "") : "";
    const lines = [];
    let omitted = 0;
    for (const entry of all) {
      if (entry.isDirectory) continue;
      const rel = entry.path;
      if (normalizedStart) {
        if (rel === normalizedStart) {
        } else if (rel.startsWith(normalizedStart + "/")) {
        } else {
          continue;
        }
      }
      const depthPath = normalizedStart && rel.startsWith(normalizedStart + "/") ? rel.slice(normalizedStart.length + 1) : rel;
      const segments = depthPath.split("/").filter(Boolean);
      if (segments.length > maxDepth) {
        continue;
      }
      if (lines.length >= maxLines) {
        omitted++;
        continue;
      }
      lines.push(`F	${entry.path}	size=${entry.size}`);
    }
    if (lines.length === 0) return "(empty)";
    if (omitted > 0) {
      lines.push(`... [${omitted} more entries omitted]`);
    }
    return lines.join("\n");
  }
  toJSON() {
    return {
      version: 1,
      projectRoot: this.projectRoot,
      updatedAt: this.updatedAt,
      fileCount: this.tree.size(),
      t: this.tree.t,
      root: this.tree.root.toJSON()
    };
  }
  static fromJSON(json) {
    const tree = new _ProjectFileTree(json.projectRoot, json.t || 16);
    tree.updatedAt = json.updatedAt;
    tree.tree.root = BTreeNode.fromJSON(json.root);
    tree.tree.recalculateSize();
    return tree;
  }
  async saveToFile(filePath) {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const data = JSON.stringify(this.toJSON());
    await fs.promises.writeFile(filePath, data, "utf8");
  }
  static async loadFromFile(filePath) {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return null;
      return _ProjectFileTree.fromJSON(parsed);
    } catch {
      return null;
    }
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BTree,
  BTreeNode,
  DEFAULT_PROJECT_SKIP_DIRS,
  ProjectFileTree,
  toPosixPath
});
//# sourceMappingURL=file-btree.js.map
