import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BTree,
  ProjectFileTree,
  toPosixPath,
  DEFAULT_PROJECT_SKIP_DIRS,
} from "../lib/file-btree.js";

test("toPosixPath: normalizes backslashes", () => {
  assert.equal(toPosixPath("src\\foo\\bar.ts"), "src/foo/bar.ts");
});

test("BTree basic operations: insert, search, update, entries", () => {
  const tree = new BTree(2); // t=2: min 1 key, max 3 keys per node (2-3-4 tree)

  const items = [
    ["src/c.ts", 3],
    ["src/a.ts", 1],
    ["src/e.ts", 5],
    ["src/b.ts", 2],
    ["src/d.ts", 4],
    ["README.md", 0],
    ["package.json", 6],
  ];

  for (const [k, v] of items) {
    tree.insert(k, v);
  }

  assert.equal(tree.size(), 7);

  // Search existing
  assert.equal(tree.search("src/c.ts"), 3);
  assert.equal(tree.search("README.md"), 0);

  // Search missing
  assert.equal(tree.search("missing.txt"), null);

  // Update
  tree.insert("src/c.ts", 300);
  assert.equal(tree.search("src/c.ts"), 300);
  assert.equal(tree.size(), 7);

  // In-order keys
  const keys = tree.keys();
  assert.deepEqual(keys, [
    "README.md",
    "package.json",
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
    "src/d.ts",
    "src/e.ts",
  ]);

  // Prefix search
  const srcEntries = tree.prefixSearch("src/");
  assert.equal(srcEntries.length, 5);
  assert.equal(srcEntries[0].key, "src/a.ts");
});

test("BTree deletion: removes keys and preserves ordering", () => {
  const tree = new BTree(2);
  const keys = ["g", "d", "b", "a", "c", "f", "e", "k", "i", "h", "j", "m", "l"];
  for (const k of keys) {
    tree.insert(k, k.charCodeAt(0));
  }

  assert.equal(tree.size(), keys.length);

  // Delete leaf
  assert.equal(tree.delete("a"), true);
  assert.equal(tree.search("a"), null);
  assert.equal(tree.size(), keys.length - 1);

  // Delete internal node
  assert.equal(tree.delete("d"), true);
  assert.equal(tree.search("d"), null);

  // Delete missing
  assert.equal(tree.delete("non-existent"), false);

  // Verify remaining keys are sorted
  const remaining = tree.keys();
  const sortedCopy = [...remaining].sort();
  assert.deepEqual(remaining, sortedCopy);
});

test("ProjectFileTree: scan, serialize, save and reload", async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pulsar-btree-test-"));
  t.after(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  // Create sample project structure
  await fs.promises.mkdir(path.join(tmpDir, "src", "sub"), { recursive: true });
  await fs.promises.mkdir(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
  await fs.promises.mkdir(path.join(tmpDir, ".git"), { recursive: true });

  await fs.promises.writeFile(path.join(tmpDir, "package.json"), "{}");
  await fs.promises.writeFile(path.join(tmpDir, "src", "index.ts"), "export const a = 1;");
  await fs.promises.writeFile(path.join(tmpDir, "src", "sub", "util.ts"), "export const b = 2;");
  await fs.promises.writeFile(path.join(tmpDir, "node_modules", "pkg", "index.js"), "module.exports = {};");
  await fs.promises.writeFile(path.join(tmpDir, ".git", "config"), "[core]");

  const pTree = new ProjectFileTree(tmpDir, 4);
  await pTree.scanProject(DEFAULT_PROJECT_SKIP_DIRS);

  // Verify node_modules and .git were skipped
  assert.ok(!pTree.has("node_modules/pkg/index.js"));
  assert.ok(!pTree.has(".git/config"));

  // Verify included files
  assert.ok(pTree.has("package.json"));
  assert.ok(pTree.has("src/index.ts"));
  assert.ok(pTree.has("src/sub/util.ts"));

  // Find in directory
  const inSrc = pTree.findInDirectory("src");
  assert.ok(inSrc.some((f) => f.path === "src/index.ts"));
  assert.ok(inSrc.some((f) => f.path === "src/sub/util.ts"));

  // Update a file
  await pTree.updatePath("src/new-file.ts"); // doesn't exist yet
  assert.ok(!pTree.has("src/new-file.ts"));
  await fs.promises.writeFile(path.join(tmpDir, "src", "new-file.ts"), "hello");
  await pTree.updatePath("src/new-file.ts");
  assert.ok(pTree.has("src/new-file.ts"));

  // Delete file
  await fs.promises.unlink(path.join(tmpDir, "src", "new-file.ts"));
  await pTree.updatePath("src/new-file.ts");
  assert.ok(!pTree.has("src/new-file.ts"));

  // Hierarchy text
  const hierarchy = pTree.toHierarchyText(2);
  assert.ok(hierarchy.includes("- package.json"));
  assert.ok(hierarchy.includes("more files"));

  // Save to file & load from file
  const treeFilePath = path.join(tmpDir, "tree.json");
  await pTree.saveToFile(treeFilePath);

  const reloaded = await ProjectFileTree.loadFromFile(treeFilePath);
  assert.ok(reloaded);
  assert.equal(reloaded.size, pTree.size);
  assert.deepEqual(reloaded.listPaths(), pTree.listPaths());
});
