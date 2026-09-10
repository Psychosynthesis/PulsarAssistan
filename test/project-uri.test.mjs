import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  parseAgentUri,
  projectFolderName,
  resolveInsideRoot,
  sameProjectRoot,
  uriForProject,
} from "../lib/project-uri.js";

test("uriForProject / parseAgentUri: round-trip an absolute path", () => {
  const root = path.resolve("/tmp/demo project");
  const uri = uriForProject(root);
  assert.match(uri, /^atom:\/\/pulsar-assistant\/project\//);
  assert.equal(parseAgentUri(uri), root);
});

test("parseAgentUri: rejects the legacy unscoped URI", () => {
  assert.equal(parseAgentUri("atom://pulsar-assistant"), null);
});

test("sameProjectRoot: compares resolved paths", () => {
  const root = path.resolve("/tmp/acp-root");
  assert.equal(sameProjectRoot(root, path.join(root, ".")), true);
  assert.equal(sameProjectRoot(root, path.resolve("/tmp/other")), false);
});

test("projectFolderName: uses the last path segment", () => {
  assert.equal(projectFolderName(path.resolve("/tmp/my-app")), "my-app");
});

test("resolveInsideRoot: allows nested paths and rejects escapes", () => {
  const cwd = path.resolve("/tmp/proj");
  assert.equal(
    resolveInsideRoot(cwd, "src/a.ts"),
    path.join(cwd, "src", "a.ts"),
  );
  assert.throws(() => resolveInsideRoot(cwd, "../secret"));
});

