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
var import_crypto = require("crypto");
var DEFAULT_PROJECT_SKIP_DIRS = /* @__PURE__ */ new Set([
  ".git",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "out",
  ".output",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".svelte-kit",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  "cmake-build-debug",
  "cmake-build-release"
]);
var BTreeNode = class _BTreeNode {
  constructor(isLeaf = true) {
    this.keys = [];
    this.values = [];
    this.children = [];
    this.isLeaf = true;
    this.isLeaf = isLeaf;
  }
  toJSON() {
    return {
      keys: this.keys,
      values: this.values,
      isLeaf: this.isLeaf,
      children: this.children.map((c) => c.toJSON())
    };
  }
  static fromJSON(json) {
    const node = new _BTreeNode(json.isLeaf);
    node.keys = [...json.keys];
    node.values = [...json.values];
    node.children = (json.children || []).map((c) => _BTreeNode.fromJSON(c));
    return node;
  }
};
var BTree = class {
  constructor(t = 16) {
    if (t < 2) throw new Error("B-tree degree t must be >= 2");
    this.t = t;
    this.root = new BTreeNode(true);
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
    if (node.isLeaf) {
      return null;
    }
    return this._searchNode(node.children[i], key);
  }
  insert(key, value) {
    const root = this.root;
    if (this._updateIfExists(root, key, value)) {
      return;
    }
    if (root.keys.length === 2 * this.t - 1) {
      const s = new BTreeNode(false);
      this.root = s;
      s.children.push(root);
      this._splitChild(s, 0);
      this._insertNonFull(s, key, value);
    } else {
      this._insertNonFull(root, key, value);
    }
  }
  _updateIfExists(node, key, value) {
    let i = 0;
    while (i < node.keys.length && key > node.keys[i]) {
      i++;
    }
    if (i < node.keys.length && key === node.keys[i]) {
      node.values[i] = value;
      return true;
    }
    if (node.isLeaf) return false;
    return this._updateIfExists(node.children[i], key, value);
  }
  _splitChild(parent, index) {
    const t = this.t;
    const y = parent.children[index];
    const z = new BTreeNode(y.isLeaf);
    const midKey = y.keys[t - 1];
    const midVal = y.values[t - 1];
    z.keys = y.keys.splice(t);
    z.values = y.values.splice(t);
    y.keys.pop();
    y.values.pop();
    if (!y.isLeaf) {
      z.children = y.children.splice(t);
    }
    parent.children.splice(index + 1, 0, z);
    parent.keys.splice(index, 0, midKey);
    parent.values.splice(index, 0, midVal);
  }
  _insertNonFull(node, key, value) {
    let i = node.keys.length - 1;
    if (node.isLeaf) {
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
        this._splitChild(node, i);
        if (key > node.keys[i]) {
          i++;
        }
      }
      this._insertNonFull(node.children[i], key, value);
    }
  }
  delete(key) {
    const deleted = this._deleteNode(this.root, key);
    if (this.root.keys.length === 0 && !this.root.isLeaf) {
      this.root = this.root.children[0];
    }
    return deleted;
  }
  _deleteNode(node, key) {
    const t = this.t;
    let idx = 0;
    while (idx < node.keys.length && key > node.keys[idx]) {
      idx++;
    }
    if (idx < node.keys.length && key === node.keys[idx]) {
      if (node.isLeaf) {
        node.keys.splice(idx, 1);
        node.values.splice(idx, 1);
        return true;
      }
      if (node.children[idx].keys.length >= t) {
        const pred = this._getPredecessor(node.children[idx]);
        node.keys[idx] = pred.key;
        node.values[idx] = pred.value;
        return this._deleteNode(node.children[idx], pred.key);
      } else if (node.children[idx + 1].keys.length >= t) {
        const succ = this._getSuccessor(node.children[idx + 1]);
        node.keys[idx] = succ.key;
        node.values[idx] = succ.value;
        return this._deleteNode(node.children[idx + 1], succ.key);
      } else {
        this._merge(node, idx);
        return this._deleteNode(node.children[idx], key);
      }
    }
    if (node.isLeaf) {
      return false;
    }
    const isLastChild = idx === node.keys.length;
    if (node.children[idx].keys.length < t) {
      this._fill(node, idx);
    }
    if (isLastChild && idx > node.keys.length) {
      return this._deleteNode(node.children[idx - 1], key);
    }
    return this._deleteNode(node.children[idx], key);
  }
  _getPredecessor(node) {
    let curr = node;
    while (!curr.isLeaf) {
      curr = curr.children[curr.children.length - 1];
    }
    return {
      key: curr.keys[curr.keys.length - 1],
      value: curr.values[curr.values.length - 1]
    };
  }
  _getSuccessor(node) {
    let curr = node;
    while (!curr.isLeaf) {
      curr = curr.children[0];
    }
    return {
      key: curr.keys[0],
      value: curr.values[0]
    };
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
    if (!child.isLeaf) {
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
    if (!child.isLeaf) {
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
    if (!child.isLeaf) {
      child.children.push(...sibling.children);
    }
    node.keys.splice(idx, 1);
    node.values.splice(idx, 1);
    node.children.splice(idx + 1, 1);
  }
  entries() {
    const result = [];
    this._traverseInOrder(this.root, (key, value) => {
      result.push({ key, value });
    });
    return result;
  }
  keys() {
    const result = [];
    this._traverseInOrder(this.root, (key) => {
      result.push(key);
    });
    return result;
  }
  values() {
    const result = [];
    this._traverseInOrder(this.root, (_, value) => {
      result.push(value);
    });
    return result;
  }
  size() {
    let count = 0;
    this._traverseInOrder(this.root, () => {
      count++;
    });
    return count;
  }
  prefixSearch(prefix) {
    const result = [];
    this._traverseInOrder(this.root, (key, value) => {
      if (key.startsWith(prefix)) {
        result.push({ key, value });
      }
    });
    return result;
  }
  _traverseInOrder(node, callback) {
    for (let i = 0; i < node.keys.length; i++) {
      if (!node.isLeaf) {
        this._traverseInOrder(node.children[i], callback);
      }
      callback(node.keys[i], node.values[i]);
    }
    if (!node.isLeaf) {
      this._traverseInOrder(node.children[node.keys.length], callback);
    }
  }
};
function toPosixPath(p) {
  return p.replace(/\\/g, "/");
}
var ProjectFileTree = class _ProjectFileTree {
  constructor(projectRoot, t = 16) {
    this.saveTimer = null;
    this.savePromise = null;
    this.projectRoot = path.resolve(projectRoot);
    this.tree = new BTree(t);
    this.updatedAt = Date.now();
  }
  get size() {
    return this.tree.size();
  }
  get lastUpdated() {
    return this.updatedAt;
  }
  get(relPath) {
    const key = toPosixPath(relPath).replace(/^\.?\//, "");
    return this.tree.search(key);
  }
  has(relPath) {
    return this.get(relPath) !== null;
  }
  set(relPath, meta) {
    const key = toPosixPath(relPath).replace(/^\.?\//, "");
    this.tree.insert(key, { ...meta, path: key });
    this.updatedAt = Date.now();
  }
  remove(relPath) {
    const key = toPosixPath(relPath).replace(/^\.?\//, "");
    const deleted = this.tree.delete(key);
    if (deleted) this.updatedAt = Date.now();
    return deleted;
  }
  listAll() {
    return this.tree.values();
  }
  listPaths() {
    return this.tree.keys();
  }
  findInDirectory(subDir) {
    const normalized = toPosixPath(subDir).replace(/^\.?\//, "").replace(/\/$/, "");
    const prefix = normalized ? `${normalized}/` : "";
    return this.tree.prefixSearch(prefix).map((entry) => entry.value);
  }
  async scanProject(skipDirs = DEFAULT_PROJECT_SKIP_DIRS) {
    const newTree = new BTree(this.tree.t);
    const walk = async (currentDir) => {
      let entries;
      try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const name = entry.name;
        if (skipDirs.has(name)) continue;
        if (name.startsWith(".") && name !== ".github" && name !== ".gitignore") {
          continue;
        }
        const fullPath = path.join(currentDir, name);
        const relPath = toPosixPath(path.relative(this.projectRoot, fullPath));
        if (entry.isDirectory()) {
          newTree.insert(relPath, {
            path: relPath,
            size: 0,
            mtime: 0,
            isDirectory: true
          });
          await walk(fullPath);
        } else if (entry.isFile()) {
          let stat = null;
          try {
            stat = await fs.promises.stat(fullPath);
          } catch {
          }
          newTree.insert(relPath, {
            path: relPath,
            size: stat?.size ?? 0,
            mtime: stat?.mtimeMs ?? 0,
            isDirectory: false
          });
        }
      }
    };
    await walk(this.projectRoot);
    this.tree = newTree;
    this.updatedAt = Date.now();
  }
  async updatePath(fullOrRelPath) {
    const fullPath = path.isAbsolute(fullOrRelPath) ? fullOrRelPath : path.join(this.projectRoot, fullOrRelPath);
    const relPath = toPosixPath(path.relative(this.projectRoot, fullPath));
    try {
      const stat = await fs.promises.stat(fullPath);
      this.set(relPath, {
        path: relPath,
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
  toHierarchyText(maxFiles = 200) {
    const files = this.listPaths();
    if (files.length === 0) return "(empty project)";
    const slice = files.slice(0, maxFiles);
    const lines = slice.map((f) => `- ${f}`);
    if (files.length > maxFiles) {
      lines.push(`... and ${files.length - maxFiles} more files`);
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
    return tree;
  }
  async saveToFile(filePath) {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tempPath = `${filePath}.${(0, import_crypto.randomBytes)(6).toString("hex")}.tmp`;
    const json = JSON.stringify(this.toJSON(), null, 2);
    await fs.promises.writeFile(tempPath, json, "utf8");
    try {
      await fs.promises.rename(tempPath, filePath);
    } catch (err) {
      try {
        await fs.promises.unlink(filePath);
        await fs.promises.rename(tempPath, filePath);
      } catch {
        await fs.promises.unlink(tempPath).catch(() => {
        });
        throw err;
      }
    }
  }
  static async loadFromFile(filePath) {
    try {
      const data = await fs.promises.readFile(filePath, "utf8");
      const parsed = JSON.parse(data);
      if (parsed && parsed.version === 1 && parsed.root) {
        return _ProjectFileTree.fromJSON(parsed);
      }
      return null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
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
