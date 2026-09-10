import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  globFiles,
  globToRegExp,
  grepFiles,
  listDirectory,
  matchGlob,
} from "../lib/grep.js";

test("matchGlob: **/*.ts matches nested TypeScript files", () => {
  assert.equal(matchGlob("src/foo.ts", "**/*.ts"), true);
  assert.equal(matchGlob("foo.ts", "**/*.ts"), true);
  assert.equal(matchGlob("src/foo.js", "**/*.ts"), false);
});

test("matchGlob: *.ts matches by basename in nested folders", () => {
  assert.equal(matchGlob("src/foo.ts", "*.ts"), true);
  assert.equal(matchGlob("foo.ts", "*.ts"), true);
});

test("globToRegExp: treats * as a single path segment", () => {
  const re = globToRegExp("src/*.ts");
  assert.equal(re.test("src/foo.ts"), true);
  assert.equal(re.test("src/nested/foo.ts"), false);
});

test("grepFiles: finds a regex across the tree and skips node_modules", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acp-grep-"));
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "hello alpha\nkeep\n");
    await fs.writeFile(path.join(root, "src", "b.ts"), "nope\n");
    await fs.writeFile(
      path.join(root, "node_modules", "pkg", "a.ts"),
      "hello hidden\n",
    );
    const matches = await grepFiles({
      cwd: root,
      pattern: "alpha",
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].line, 1);
    assert.match(matches[0].path, /a\.ts$/);
    const oneFile = await grepFiles({
      cwd: root,
      pattern: "alpha",
      searchPath: path.join("src", "a.ts"),
    });
    assert.equal(oneFile.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grepFiles and globFiles: refuse paths outside the project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acp-grep-"));
  try {
    await assert.rejects(() =>
      grepFiles({ cwd: root, pattern: "x", searchPath: ".." }),
    );
    await assert.rejects(() =>
      globFiles({ cwd: root, pattern: "**/*", searchPath: ".." }),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("globFiles and listDirectory: return project files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acp-glob-"));
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "a.ts"), "");
    await fs.writeFile(path.join(root, "readme.md"), "");
    const files = await globFiles({ cwd: root, pattern: "**/*.ts" });
    assert.equal(files.length, 1);
    const listing = await listDirectory(root);
    assert.deepEqual(
      listing.map((entry) => entry.name).sort(),
      ["readme.md", "src"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
