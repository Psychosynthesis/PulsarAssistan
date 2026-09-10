import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveProjectPolicy } from "../lib/project-policy.js";

test("resolveProjectPolicy: denies when projects is missing", () => {
  const root = path.resolve("/tmp/app");
  assert.deepEqual(resolveProjectPolicy(root, undefined), {
    allowCommands: false,
    testCommand: null,
    maxTurnRequests: null,
  });
});

test("resolveProjectPolicy: matches a configured project root", () => {
  const root = path.resolve("/tmp/app");
  const policy = resolveProjectPolicy(root, {
    [root]: { allowCommands: true, testCommand: "npm test" },
  });
  assert.equal(policy.allowCommands, true);
  assert.equal(policy.testCommand, "npm test");
  assert.equal(policy.maxTurnRequests, null);
});

test("resolveProjectPolicy: reads a positive maxTurnRequests", () => {
  const root = path.resolve("/tmp/app");
  const policy = resolveProjectPolicy(root, {
    [root]: { maxTurnRequests: 7 },
  });
  assert.equal(policy.maxTurnRequests, 7);
});

test("resolveProjectPolicy: ignores invalid maxTurnRequests", () => {
  const root = path.resolve("/tmp/app");
  for (const value of [0, -1, 1.5, "12", null, undefined]) {
    const policy = resolveProjectPolicy(root, {
      [root]: { maxTurnRequests: value },
    });
    assert.equal(policy.maxTurnRequests, null);
  }
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
  assert.equal(policy.maxTurnRequests, null);
});

test("resolveProjectPolicy: matches equivalent path forms", () => {
  const root = path.resolve("/tmp/app");
  const policy = resolveProjectPolicy(`${root}${path.sep}`, {
    [path.join(root, ".")]: { allowCommands: true, testCommand: "go test" },
  });
  assert.equal(policy.allowCommands, true);
  assert.equal(policy.testCommand, "go test");
});
