import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  findFiles,
  grepFiles,
  listDirectory,
  parseDslPattern,
  makeExtensionsMatcher,
} from "../lib/grep.js";
import { ProjectFileTree } from "../lib/file-btree.js";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1"));

test("parseDslPattern: matches wildcards and single char", () => {
  const matcher = parseDslPattern("*.ts");
  assert.equal(matcher("main.ts"), true);
  assert.equal(matcher("main.js"), false);

  const matcherQ = parseDslPattern("file?.ts");
  assert.equal(matcherQ("file1.ts"), true);
  assert.equal(matcherQ("file12.ts"), false);
});

test("parseDslPattern: handles logical OR (|) and AND (&)", () => {
  const orMatcher = parseDslPattern("*.ts | *.tsx | *.js");
  assert.equal(orMatcher("index.ts"), true);
  assert.equal(orMatcher("index.tsx"), true);
  assert.equal(orMatcher("index.js"), true);
  assert.equal(orMatcher("index.css"), false);

  const andMatcher = parseDslPattern("*test* & *.mjs");
  assert.equal(andMatcher("grep.test.mjs"), true);
  assert.equal(andMatcher("grep.mjs"), false);
  assert.equal(andMatcher("test.js"), false);

  const complexMatcher = parseDslPattern("*agent* & *.ts | *test* & *.mjs");
  assert.equal(complexMatcher("agent-view.ts"), true);
  assert.equal(complexMatcher("grep.test.mjs"), true);
  assert.equal(complexMatcher("other.txt"), false);
});

test("parseDslPattern: handles escaping", () => {
  const escapedOr = parseDslPattern("foo\\|bar");
  assert.equal(escapedOr("foo|bar"), true);
  assert.equal(escapedOr("foo"), false);

  const escapedAnd = parseDslPattern("foo\\&bar");
  assert.equal(escapedAnd("foo&bar"), true);

  const escapedStar = parseDslPattern("foo\\*bar");
  assert.equal(escapedStar("foo*bar"), true);
  assert.equal(escapedStar("fooxxxbar"), false);
});

test("makeExtensionsMatcher: matches extensions case-insensitively when requested", () => {
  const matcher = makeExtensionsMatcher(["ts", ".json"]);
  assert.equal(matcher("package.json"), true);
  assert.equal(matcher("main.ts"), true);
  assert.equal(matcher("main.js"), false);

  const ciMatcher = makeExtensionsMatcher(["TS"], true);
  assert.equal(ciMatcher("main.ts"), true);
  assert.equal(ciMatcher("MAIN.TS"), true);
});

test("findFiles: finds files using DSL pattern and extensions filter", async () => {
  const matches = await findFiles({
    cwd: projectRoot,
    pattern: "*test* & *.mjs",
  });
  assert.ok(matches.length > 0);
  assert.ok(matches.some((f) => f.endsWith("grep.test.mjs")));
  assert.ok(!matches.some((f) => f.endsWith("package.json")));
});

test("findFiles: leverages ProjectFileTree index", async () => {
  const tree = new ProjectFileTree(projectRoot);
  await tree.scanProject();

  const matches = await findFiles({
    cwd: projectRoot,
    extensions: ["json"],
    fileTree: tree,
  });
  assert.ok(matches.length > 0);
  assert.ok(matches.some((f) => f.endsWith("package.json")));
  assert.ok(!matches.some((f) => f.endsWith(".ts")));
});

test("grepFiles: literal search across files", async () => {
  const matches = await grepFiles({
    cwd: projectRoot,
    query: "parseDslPattern",
    searchPath: "src",
  });
  assert.ok(matches.length > 0);
  assert.ok(matches.some((m) => m.path.endsWith("grep.ts")));
  assert.ok(matches.every((m) => m.text.includes("parseDslPattern")));
});

test("grepFiles: leverages ProjectFileTree index", async () => {
  const tree = new ProjectFileTree(projectRoot);
  await tree.scanProject();

  const matches = await grepFiles({
    cwd: projectRoot,
    query: "ProjectFileTree",
    searchPath: "src",
    fileTree: tree,
  });
  assert.ok(matches.length > 0);
  assert.ok(matches.every((m) => m.text.includes("ProjectFileTree")));
});

test("findFiles and grepFiles: refuse paths outside the project", async () => {
  await assert.rejects(
    findFiles({ cwd: projectRoot, searchPath: "../" }),
    /outside the project/,
  );
  await assert.rejects(
    grepFiles({ cwd: projectRoot, query: "foo", searchPath: "C:\\Windows" }),
    /outside the project/,
  );
});

test("listDirectory: returns directory entries", async () => {
  const entries = await listDirectory(projectRoot);
  const names = new Set(entries.map((e) => e.name));
  assert.ok(names.has("package.json"));
  assert.ok(names.has("src"));
});
