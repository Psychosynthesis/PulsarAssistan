import * as fs from "fs";
import * as path from "path";
import {
  buildIgnoredDirsSet,
  getConfiguredIgnoredDirs,
} from "./ignored-dirs";

export interface FileEntryInfo {
  size: number;
  mtime: number;
  isDirectory: boolean;
}

export interface FileMetadata extends FileEntryInfo {
  path: string; // posix-style relative path from project root
}

export interface SerializedBTreeNode<V> {
  leaf: boolean;
  keys: string[];
  values: V[];
  children?: SerializedBTreeNode<V>[];
}

export interface SerializedProjectFileTree {
  version: 1;
  projectRoot: string;
  updatedAt: number;
  fileCount: number;
  t: number;
  root: SerializedBTreeNode<FileEntryInfo>;
}

export const DEFAULT_PROJECT_SKIP_DIRS: Set<string> = buildIgnoredDirsSet();

export function toPosixPath(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

export class BTreeNode<V> {
  leaf: boolean;
  keys: string[];
  values: V[];
  children: BTreeNode<V>[];

  constructor(leaf = true) {
    this.leaf = leaf;
    this.keys = [];
    this.values = [];
    this.children = [];
  }

  toJSON(): SerializedBTreeNode<V> {
    const out: SerializedBTreeNode<V> = {
      leaf: this.leaf,
      keys: this.keys,
      values: this.values,
    };
    if (!this.leaf && this.children.length > 0) {
      out.children = this.children.map((c) => c.toJSON());
    }
    return out;
  }

  static fromJSON<V>(json: SerializedBTreeNode<V>): BTreeNode<V> {
    const node = new BTreeNode<V>(json.leaf);
    node.keys = [...json.keys];
    node.values = json.values.map((v) => {
      if (v && typeof v === "object" && "path" in v) {
        const { path: _p, ...rest } = v as Record<string, unknown>;
        return rest as unknown as V;
      }
      return v;
    });
    if (json.children) {
      node.children = json.children.map((c) => BTreeNode.fromJSON<V>(c));
    }
    return node;
  }
}

export class BTree<V> {
  t: number;
  root: BTreeNode<V>;
  private _size = 0;

  constructor(degree = 16) {
    if (degree < 2) throw new Error("Degree t must be >= 2");
    this.t = degree;
    this.root = new BTreeNode<V>(true);
  }

  size(): number {
    return this._size;
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
    if (node.leaf) {
      return null;
    }
    return this._searchNode(node.children[i], key);
  }

  insert(key: string, value: V): void {
    const existing = this.search(key);
    if (existing !== null) {
      this._updateNode(this.root, key, value);
      return;
    }

    const r = this.root;
    if (r.keys.length === 2 * this.t - 1) {
      const s = new BTreeNode<V>(false);
      this.root = s;
      s.children.push(r);
      this._splitChild(s, 0, r);
      this._insertNonFull(s, key, value);
    } else {
      this._insertNonFull(r, key, value);
    }
    this._size++;
  }

  private _updateNode(node: BTreeNode<V>, key: string, value: V): void {
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

  private _insertNonFull(node: BTreeNode<V>, key: string, value: V): void {
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

  private _splitChild(parent: BTreeNode<V>, i: number, child: BTreeNode<V>): void {
    const t = this.t;
    const z = new BTreeNode<V>(child.leaf);

    z.keys = child.keys.splice(t);
    z.values = child.values.splice(t);

    const midKey = child.keys.pop()!;
    const midVal = child.values.pop()!;

    if (!child.leaf) {
      z.children = child.children.splice(t);
    }

    parent.children.splice(i + 1, 0, z);
    parent.keys.splice(i, 0, midKey);
    parent.values.splice(i, 0, midVal);
  }

  delete(key: string): boolean {
    const deleted = this._deleteNode(this.root, key);
    if (deleted) {
      this._size--;
      if (this.root.keys.length === 0 && !this.root.leaf) {
        this.root = this.root.children[0];
      }
    }
    return deleted;
  }

  private _deleteNode(node: BTreeNode<V>, key: string): boolean {
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

  private _deleteInternalNode(node: BTreeNode<V>, idx: number): boolean {
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

  private _getPred(node: BTreeNode<V>, idx: number): { key: string; val: V } {
    let curr = node.children[idx];
    while (!curr.leaf) {
      curr = curr.children[curr.children.length - 1];
    }
    return {
      key: curr.keys[curr.keys.length - 1],
      val: curr.values[curr.values.length - 1],
    };
  }

  private _getSucc(node: BTreeNode<V>, idx: number): { key: string; val: V } {
    let curr = node.children[idx + 1];
    while (!curr.leaf) {
      curr = curr.children[0];
    }
    return { key: curr.keys[0], val: curr.values[0] };
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

    if (!child.leaf) {
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

    if (!child.leaf) {
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

    if (!child.leaf) {
      child.children.push(...sibling.children);
    }

    node.keys.splice(idx, 1);
    node.values.splice(idx, 1);
    node.children.splice(idx + 1, 1);
  }

  keys(): string[] {
    const res: string[] = [];
    this._traverseKeys(this.root, res);
    return res;
  }

  private _traverseKeys(node: BTreeNode<V>, res: string[]): void {
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

  entries(): Array<{ key: string; value: V }> {
    const res: Array<{ key: string; value: V }> = [];
    this._traverseEntries(this.root, res);
    return res;
  }

  private _traverseEntries(node: BTreeNode<V>, res: Array<{ key: string; value: V }>): void {
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

  prefixSearch(prefix: string): Array<{ key: string; value: V }> {
    const res: Array<{ key: string; value: V }> = [];
    this._prefixSearchNode(this.root, prefix, res);
    return res;
  }

  private _prefixSearchNode(
    node: BTreeNode<V>,
    prefix: string,
    res: Array<{ key: string; value: V }>,
  ): void {
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

  recalculateSize(): number {
    let count = 0;
    const walk = (node: BTreeNode<V>) => {
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
}

export class ProjectFileTree {
  projectRoot: string;
  updatedAt: number;
  private tree: BTree<FileEntryInfo>;

  constructor(projectRoot: string, degree = 16) {
    this.projectRoot = path.resolve(projectRoot);
    this.updatedAt = Date.now();
    this.tree = new BTree<FileEntryInfo>(degree);
  }

  get size(): number {
    return this.tree.size();
  }

  get degree(): number {
    return this.tree.t;
  }

  has(posixRelPath: string): boolean {
    return this.tree.search(posixRelPath) !== null;
  }

  get(posixRelPath: string): FileMetadata | null {
    const val = this.tree.search(posixRelPath);
    if (!val) return null;
    return {
      path: posixRelPath,
      size: val.size,
      mtime: val.mtime,
      isDirectory: val.isDirectory,
    };
  }

  set(posixRelPath: string, meta: FileMetadata | FileEntryInfo): void {
    this.tree.insert(posixRelPath, {
      size: meta.size,
      mtime: meta.mtime,
      isDirectory: meta.isDirectory,
    });
    this.updatedAt = Date.now();
  }

  remove(posixRelPath: string): boolean {
    const res = this.tree.delete(posixRelPath);
    if (res) this.updatedAt = Date.now();
    return res;
  }

  listPaths(): string[] {
    return this.tree.keys();
  }

  listAll(): FileMetadata[] {
    return this.tree.entries().map((e) => ({
      path: e.key,
      size: e.value.size,
      mtime: e.value.mtime,
      isDirectory: e.value.isDirectory,
    }));
  }

  findInDirectory(subDir: string): FileMetadata[] {
    let normalized = toPosixPath(subDir).replace(/^\.\/?/, "");
    if (normalized && !normalized.endsWith("/")) {
      normalized += "/";
    }
    const entries = this.tree.prefixSearch(normalized);
    return entries.map((e) => ({
      path: e.key,
      size: e.value.size,
      mtime: e.value.mtime,
      isDirectory: e.value.isDirectory,
    }));
  }

  async scanProject(skipDirs: Set<string> = getConfiguredIgnoredDirs()): Promise<void> {
    const newTree = new BTree<FileEntryInfo>(this.tree.t);

    const stack: Array<{ dir: string; relative: string }> = [
      { dir: this.projectRoot, relative: "" },
    ];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;

      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (skipDirs.has(entry.name)) continue;

        const relPath = current.relative
          ? `${current.relative}/${entry.name}`
          : entry.name;
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
              isDirectory: false,
            });
          } catch {
            // Ignore stat errors for inaccessible files
          }
        }
      }
    }

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

  toHierarchyText(maxLines = 300, startPath = ".", maxDepth = 5): string {
    const all = this.listAll();
    if (all.length === 0) return "(empty project)";

    const normalizedStart = startPath
      ? toPosixPath(startPath).replace(/^\.\/?/, "").replace(/\/+$/, "")
      : "";
    const lines: string[] = [];
    let omitted = 0;

    for (const entry of all) {
      if (entry.isDirectory) continue;
      const rel = entry.path;
      if (normalizedStart) {
        if (rel === normalizedStart) {
          // exact match
        } else if (rel.startsWith(normalizedStart + "/")) {
          // inside startPath
        } else {
          continue;
        }
      }

      const depthPath =
        normalizedStart && rel.startsWith(normalizedStart + "/")
          ? rel.slice(normalizedStart.length + 1)
          : rel;
      const segments = depthPath.split("/").filter(Boolean);
      if (segments.length > maxDepth) {
        continue;
      }

      if (lines.length >= maxLines) {
        omitted++;
        continue;
      }

      lines.push(`F\t${entry.path}\tsize=${entry.size}`);
    }

    if (lines.length === 0) return "(empty)";
    if (omitted > 0) {
      lines.push(`... [${omitted} more entries omitted]`);
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
    tree.tree.root = BTreeNode.fromJSON<FileEntryInfo>(json.root);
    tree.tree.recalculateSize();
    return tree;
  }

  async saveToFile(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const data = JSON.stringify(this.toJSON());
    await fs.promises.writeFile(filePath, data, "utf8");
  }

  static async loadFromFile(filePath: string): Promise<ProjectFileTree | null> {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as SerializedProjectFileTree;
      if (!parsed || parsed.version !== 1) return null;
      return ProjectFileTree.fromJSON(parsed);
    } catch {
      return null;
    }
  }
}
