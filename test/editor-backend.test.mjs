import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isInsideRoots,
  PulsarEditorBackend,
} from "../lib/editor/editor-backend.js";

test("isInsideRoots correctly checks root boundaries", () => {
  const root = path.resolve("/app/project");
  assert.equal(isInsideRoots(path.join(root, "src", "index.ts"), [root]), true);
  assert.equal(isInsideRoots(root, [root]), true);
  assert.equal(isInsideRoots(path.resolve("/other/path"), [root]), false);
});

test("PulsarEditorBackend read and write text file fallback when no active editor", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "editor-backend-test-"));
  const backend = new PulsarEditorBackend();

  try {
    const testFile = path.join(tmpDir, "nested", "sub", "test.txt");
    const content = "line 1\nline 2\nline 3\nline 4\nline 5\n";

    await backend.writeTextFile(testFile, content);
    assert.equal(fs.existsSync(testFile), true);

    const fullRead = await backend.readTextFile(testFile);
    assert.equal(fullRead.content, content);

    const sliceRead = await backend.readTextFile(testFile, { line: 2, limit: 2 });
    assert.equal(sliceRead.content, "line 2\nline 3");

    const roots = await backend.allowedRealRoots(tmpDir);
    await backend.assertProjectPath(testFile, roots, false);
    assert.equal(await backend.isPathInRoots(testFile, roots), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
