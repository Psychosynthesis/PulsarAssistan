import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveProjectPolicy } from "../lib/project-policy.js";

test("resolveProjectPolicy: denies when projects is missing", () => {
  const root = path.resolve("/tmp/app");
  assert.deepEqual(resolveProjectPolicy(root, undefined), {
    allowCommands: false,
    testCommand: null,
  });
});

test("resolveProjectPolicy: matches a configured project root", () => {
  const root = path.resolve("/tmp/app");
  const policy = resolveProjectPolicy(root, {
    [root]: { allowCommands: true, testCommand: "npm test" },
  });
  assert.equal(policy.allowCommands, true);
  assert.equal(policy.testCommand, "npm test");
});

test("resolveProjectPolicy: ignore allowCommands unless it is boolean true", () => {
  const root = path.resolve("/tmp/app");
  const policy = resolveProjectPolicy(root, {
    [root]: { allowCommands: "true", testCommand: "  " },
  });
  assert.equal(policy.allowCommands, false);
  assert.equal(policy.testCommand, null);
});

test("resolveProjectPolicy: does not match a sibling folder", () => {
  const root = path.resolve("/tmp/app");
  const policy = resolveProjectPolicy(root, {
    [path.resolve("/tmp/other")]: {
      allowCommands: true,
      testCommand: "pytest",
    },
  });
  assert.equal(policy.allowCommands, false);
  assert.equal(policy.testCommand, null);
});

test("resolveProjectPolicy: matches equivalent path forms", () => {
  const root = path.resolve("/tmp/app");
  const policy = resolveProjectPolicy(`${root}${path.sep}`, {
    [path.join(root, ".")]: { allowCommands: true, testCommand: "go test" },
  });
  assert.equal(policy.allowCommands, true);
  assert.equal(policy.testCommand, "go test");
});
