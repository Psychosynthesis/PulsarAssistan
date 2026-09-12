import { test } from "node:test";
import assert from "node:assert/strict";
import { planGitCommand } from "../lib/git-command.js";

test("planGitCommand: blocks --output and -o anywhere", () => {
  assert.throws(
    () => planGitCommand(["diff", "--output=malicious.txt"]),
    /git option --output is not allowed/,
  );
  assert.throws(
    () => planGitCommand(["diff", "--output", "malicious.txt"]),
    /git option --output is not allowed/,
  );
  assert.throws(
    () => planGitCommand(["log", "-o", "malicious.txt"]),
    /git option -o is not allowed/,
  );
  assert.throws(
    () => planGitCommand(["show", "--output=foo.txt"]),
    /git option --output is not allowed/,
  );
});

test("planGitCommand: blocks --git-dir, --work-tree anywhere in arguments", () => {
  assert.throws(
    () => planGitCommand(["status", "--work-tree=/etc"]),
    /git option --work-tree is not allowed/,
  );
  assert.throws(
    () => planGitCommand(["status", "--git-dir=/etc/.git"]),
    /git option --git-dir is not allowed/,
  );
});

test("planGitCommand: allows safe read commands", () => {
  const plan = planGitCommand(["status", "--short"]);
  assert.equal(plan.needsPermission, false);
  assert.deepEqual(plan.args, ["status", "--short"]);
});

test("planGitCommand: requires permission for write commands", () => {
  const plan = planGitCommand(["checkout", "-b", "new-feature"]);
  assert.equal(plan.needsPermission, true);
});
