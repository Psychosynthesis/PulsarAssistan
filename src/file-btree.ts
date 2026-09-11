import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

export interface FileMetadata {
  path: string; // Relative POSIX path from projectRoot, e.g. "src/main.ts"
  size: number;
  mtime: number;
  isDirectory: boolean;
}

export const DEFAULT_PROJECT_SKIP_DIRS = new Set([
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
  "cmake-build-release",
]);

export interface SerializedBTreeNode<V> {
  keys: string[];
  values: V[];
  isLeaf: boolean;
  children: SerializedBTreeNode<V>[];
}

export interface SerializedProjectFileTree {
  version: 1;
  projectRoot: string;
  updatedAt: number;
  fileCount: number;
  t: number;
  root: SerializedBTreeNode<FileMetadata>;
}

export class BTreeNode<V> {
  keys: string[] = [];
  values: V[] = [];
  children: BTreeNode<V>[] = [];
  isLeaf: boolean = true;

  constructor(isLeaf = true) {
    this.isLeaf = isLeaf;
  }

  toJSON(): SerializedBTreeNode<V> {
    return {
      keys: this.keys,
      values: this.values,
      isLeaf: this.isLeaf,
      children: this.children.map((c) => c.toJSON()),
    };
  }

  static fromJSON<V>(json: SerializedBTreeNode<V>): BTreeNode<V> {
    const node = new BTreeNode<V>(json.isLeaf);
    node.keys = [...json.keys];
    node.values = [...json.values];
    node.children = (json.children || []).map((c) => BTreeNode.fromJSON<V>(c));
    return node;
  }
}

export class BTree<V> {
  readonly t: number; // Minimum degree (t >= 2)
  root: BTreeNode<V>;

  constructor(t = 16) {
    if (t < 2) throw new Error("B-tree degree t must be >= 2");
    this.t = t;
    this.root = new BTreeNode<V>(true);
  }

  search(key: string): V | null {
    return this._searchNode(this.root, key);
  }

  private _searchNode(node: BTreeNode<V>, key: string): V | null {
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

  insert(key: string, value: V): void {
    const root = this.root;
    // If key already exists in the tree, update its value in-place
    if (this._updateIfExists(root, key, value)) {
      return;
    }

    // Root is full: tree grows in height
    if (root.keys.length === 2 * this.t - 1) {
      const s = new BTreeNode<V>(false);
      this.root = s;
      s.children.push(root);
      this._splitChild(s, 0);
      this._insertNonFull(s, key, value);
    } else {
      this._insertNonFull(root, key, value);
    }
  }

  private _updateIfExists(node: BTreeNode<V>, key: string, value: V): boolean {
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

  private _splitChild(parent: BTreeNode<V>, index: number): void {
    const t = this.t;
    const y = parent.children[index];
    const z = new BTreeNode<V>(y.isLeaf);

    // Mid key moves up to parent
    const midKey = y.keys[t - 1];
    const midVal = y.values[t - 1];

    z.keys = y.keys.splice(t);
    z.values = y.values.splice(t);

    // Pop the mid element
    y.keys.pop();
    y.values.pop();

    if (!y.isLeaf) {
      z.children = y.children.splice(t);
    }

    parent.children.splice(index + 1, 0, z);
    parent.keys.splice(index, 0, midKey);
    parent.values.splice(index, 0, midVal);
  }

  private _insertNonFull(node: BTreeNode<V>, key: string, value: V): void {
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

  delete(key: string): boolean {
    const deleted = this._deleteNode(this.root, key);
    if (this.root.keys.length === 0 && !this.root.isLeaf) {
      this.root = this.root.children[0];
    }
    return deleted;
  }

  private _deleteNode(node: BTreeNode<V>, key: string): boolean {
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

      // Key is in internal node
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
      return false; // Key not in tree
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

  private _getPredecessor(node: BTreeNode<V>): { key: string; value: V } {
    let curr = node;
    while (!curr.isLeaf) {
      curr = curr.children[curr.children.length - 1];
    }
    return {
      key: curr.keys[curr.keys.length - 1],
      value: curr.values[curr.values.length - 1],
    };
  }

  private _getSuccessor(node: BTreeNode<V>): { key: string; value: V } {
    let curr = node;
    while (!curr.isLeaf) {
      curr = curr.children[0];
    }
    return {
      key: curr.keys[0],
      value: curr.values[0],
    };
  }

  private _fill(node: BTreeNode<V>, idx: number): void {
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

  private _borrowFromPrev(node: BTreeNode<V>, idx: number): void {
    const child = node.children[idx];
    const sibling = node.children[idx - 1];

    child.keys.unshift(node.keys[idx - 1]);
    child.values.unshift(node.values[idx - 1]);

    if (!child.isLeaf) {
      child.children.unshift(sibling.children.pop()!);
    }

    node.keys[idx - 1] = sibling.keys.pop()!;
    node.values[idx - 1] = sibling.values.pop()!;
  }

  private _borrowFromNext(node: BTreeNode<V>, idx: number): void {
    const child = node.children[idx];
    const sibling = node.children[idx + 1];

    child.keys.push(node.keys[idx]);
    child.values.push(node.values[idx]);

    if (!child.isLeaf) {
      child.children.push(sibling.children.shift()!);
    }

    node.keys[idx] = sibling.keys.shift()!;
    node.values[idx] = sibling.values.shift()!;
  }

  private _merge(node: BTreeNode<V>, idx: number): void {
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

  entries(): Array<{ key: string; value: V }> {
    const result: Array<{ key: string; value: V }> = [];
    this._traverseInOrder(this.root, (key, value) => {
      result.push({ key, value });
    });
    return result;
  }

  keys(): string[] {
    const result: string[] = [];
    this._traverseInOrder(this.root, (key) => {
      result.push(key);
    });
    return result;
  }

  values(): V[] {
    const result: V[] = [];
    this._traverseInOrder(this.root, (_, value) => {
      result.push(value);
    });
    return result;
  }

  size(): number {
    let count = 0;
    this._traverseInOrder(this.root, () => {
      count++;
    });
    return count;
  }

  prefixSearch(prefix: string): Array<{ key: string; value: V }> {
    const result: Array<{ key: string; value: V }> = [];
    this._traverseInOrder(this.root, (key, value) => {
      if (key.startsWith(prefix)) {
        result.push({ key, value });
      }
    });
    return result;
  }

  private _traverseInOrder(
    node: BTreeNode<V>,
    callback: (key: string, value: V) => void,
  ): void {
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
}

export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export class ProjectFileTree {
  private tree: BTree<FileMetadata>;
  readonly projectRoot: string;
  private updatedAt: number;
  private saveTimer: NodeJS.Timeout | null = null;
  private savePromise: Promise<void> | null = null;

  constructor(projectRoot: string, t = 16) {
    this.projectRoot = path.resolve(projectRoot);
    this.tree = new BTree<FileMetadata>(t);
    this.updatedAt = Date.now();
  }

  get size(): number {
    return this.tree.size();
  }

  get lastUpdated(): number {
    return this.updatedAt;
  }

  get(relPath: string): FileMetadata | null {
    const key = toPosixPath(relPath).replace(/^\.?\//, "");
    return this.tree.search(key);
  }

  has(relPath: string): boolean {
    return this.get(relPath) !== null;
  }

  set(relPath: string, meta: FileMetadata): void {
    const key = toPosixPath(relPath).replace(/^\.?\//, "");
    this.tree.insert(key, { ...meta, path: key });
    this.updatedAt = Date.now();
  }

  remove(relPath: string): boolean {
    const key = toPosixPath(relPath).replace(/^\.?\//, "");
    const deleted = this.tree.delete(key);
    if (deleted) this.updatedAt = Date.now();
    return deleted;
  }

  listAll(): FileMetadata[] {
    return this.tree.values();
  }

  listPaths(): string[] {
    return this.tree.keys();
  }

  findInDirectory(subDir: string): FileMetadata[] {
    const normalized = toPosixPath(subDir).replace(/^\.?\//, "").replace(/\/$/, "");
    const prefix = normalized ? `${normalized}/` : "";
    return this.tree.prefixSearch(prefix).map((entry) => entry.value);
  }

  async scanProject(skipDirs: Set<string> = DEFAULT_PROJECT_SKIP_DIRS): Promise<void> {
    const newTree = new BTree<FileMetadata>(this.tree.t);

    const walk = async (currentDir: string): Promise<void> => {
      let entries: fs.Dirent[];
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
            isDirectory: true,
          });
          await walk(fullPath);
        } else if (entry.isFile()) {
          let stat: fs.Stats | null = null;
          try {
            stat = await fs.promises.stat(fullPath);
          } catch {}
          newTree.insert(relPath, {
            path: relPath,
            size: stat?.size ?? 0,
            mtime: stat?.mtimeMs ?? 0,
            isDirectory: false,
          });
        }
      }
    };

    await walk(this.projectRoot);
    this.tree = newTree;
    this.updatedAt = Date.now();
  }

  async updatePath(fullOrRelPath: string): Promise<void> {
    const fullPath = path.isAbsolute(fullOrRelPath)
      ? fullOrRelPath
      : path.join(this.projectRoot, fullOrRelPath);
    const relPath = toPosixPath(path.relative(this.projectRoot, fullPath));

    try {
      const stat = await fs.promises.stat(fullPath);
      this.set(relPath, {
        path: relPath,
        size: stat.size,
        mtime: stat.mtimeMs,
        isDirectory: stat.isDirectory(),
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.remove(relPath);
      }
    }
  }

  toHierarchyText(maxFiles = 200): string {
    const files = this.listPaths();
    if (files.length === 0) return "(empty project)";
    const slice = files.slice(0, maxFiles);
    const lines = slice.map((f) => `- ${f}`);
    if (files.length > maxFiles) {
      lines.push(`... and ${files.length - maxFiles} more files`);
    }
    return lines.join("\n");
  }

  toJSON(): SerializedProjectFileTree {
    return {
      version: 1,
      projectRoot: this.projectRoot,
      updatedAt: this.updatedAt,
      fileCount: this.tree.size(),
      t: this.tree.t,
      root: this.tree.root.toJSON(),
    };
  }

  static fromJSON(json: SerializedProjectFileTree): ProjectFileTree {
    const tree = new ProjectFileTree(json.projectRoot, json.t || 16);
    tree.updatedAt = json.updatedAt;
    tree.tree.root = BTreeNode.fromJSON<FileMetadata>(json.root);
    return tree;
  }

  async saveToFile(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    const json = JSON.stringify(this.toJSON(), null, 2);
    await fs.promises.writeFile(tempPath, json, "utf8");
    try {
      await fs.promises.rename(tempPath, filePath);
    } catch (err) {
      try {
        await fs.promises.unlink(filePath);
        await fs.promises.rename(tempPath, filePath);
      } catch {
        await fs.promises.unlink(tempPath).catch(() => {});
        throw err;
      }
    }
  }

  static async loadFromFile(filePath: string): Promise<ProjectFileTree | null> {
    try {
      const data = await fs.promises.readFile(filePath, "utf8");
      const parsed = JSON.parse(data) as SerializedProjectFileTree;
      if (parsed && parsed.version === 1 && parsed.root) {
        return ProjectFileTree.fromJSON(parsed);
      }
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
