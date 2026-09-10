"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/git-command.ts
var git_command_exports = {};
__export(git_command_exports, {
  planGitCommand: () => planGitCommand
});
module.exports = __toCommonJS(git_command_exports);
var READ = /* @__PURE__ */ new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "blame",
  "rev-parse",
  "ls-files"
]);
var WRITE = /* @__PURE__ */ new Set(["checkout", "switch", "add", "commit"]);
var ALLOWED = /* @__PURE__ */ new Set([...READ, ...WRITE]);
var BLOCKED_ANYWHERE = /* @__PURE__ */ new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--bare"
]);
function flagName(token) {
  return token.split("=")[0];
}
function hasCommitMessage(argv) {
  for (const token of argv) {
    if (token === "-m" || token === "--message") return true;
    if (token.startsWith("--message=")) return true;
    if (/^-.*m/.test(token) && !token.startsWith("--")) return true;
  }
  return false;
}
function planGitCommand(argv) {
  if (argv[0] === "git") argv = argv.slice(1);
  if (argv.length === 0) {
    throw new Error(
      "git requires arguments, e.g. status or checkout -b topic."
    );
  }
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-")) {
    const flag = flagName(argv[i]);
    if (flag === "-C" || flag === "-c" || BLOCKED_ANYWHERE.has(flag)) {
      throw new Error(`git option ${flag} is not allowed.`);
    }
    i += 1;
  }
  const sub = argv[i];
  if (!sub || sub.startsWith("-")) {
    throw new Error(
      "Pass a git subcommand first (status, diff, checkout, ...)."
    );
  }
  if (!ALLOWED.has(sub)) {
    throw new Error(
      `git ${sub} is not allowed. Allowed: status, diff, log, show, branch, blame, checkout, switch, add, commit.`
    );
  }
  for (const token of argv) {
    if (BLOCKED_ANYWHERE.has(flagName(token))) {
      throw new Error(`git option ${flagName(token)} is not allowed.`);
    }
  }
  if (sub === "branch" && argv.some(
    (token) => token === "-d" || token === "-D" || token === "--delete" || token === "-f" || token === "--force"
  )) {
    throw new Error("git branch delete/force is not allowed.");
  }
  if (sub === "commit") {
    if (!hasCommitMessage(argv)) {
      throw new Error('git commit requires -m "message".');
    }
    if (!argv.includes("--no-verify") && !argv.includes("-n")) {
      argv = [...argv, "--no-verify"];
    }
  }
  return {
    args: argv,
    needsPermission: WRITE.has(sub),
    title: `git ${argv.join(" ")}`
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  planGitCommand
});
//# sourceMappingURL=git-command.js.map
