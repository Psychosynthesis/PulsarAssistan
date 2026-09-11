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
var ALLOWED = /* @__PURE__ */ new Set([...READ, ...WRITE, "apply"]);
var BLOCKED_ANYWHERE = /* @__PURE__ */ new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--bare"
]);
var BRANCH_MUTATING = /* @__PURE__ */ new Set([
  "-m",
  "--move",
  "-c",
  "--copy",
  "-d",
  "--delete",
  "--track",
  "--no-track"
]);
var BRANCH_BLOCKED = /* @__PURE__ */ new Set([
  "-M",
  "-C",
  "-D",
  "-f",
  "--force",
  "--edit-description"
]);
var APPLY_READ_FLAGS = /* @__PURE__ */ new Set([
  "--check",
  "--numstat",
  "--stat",
  "--summary"
]);
var APPLY_INDEX_FLAGS = /* @__PURE__ */ new Set(["--index", "--cached"]);
var APPLY_BLOCKED = /* @__PURE__ */ new Set(["--unsafe-paths"]);
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
function branchNeedsPermission(args) {
  const tokens = args.slice(1);
  if (tokens.some((token) => BRANCH_MUTATING.has(flagName(token)))) {
    return true;
  }
  return tokens.length > 0 && tokens.every((token) => !token.startsWith("-") && token !== "--");
}
function applyNeedsPermission(args) {
  const tokens = args.slice(1);
  if (tokens.some((token) => APPLY_INDEX_FLAGS.has(flagName(token)))) {
    return true;
  }
  const hasReadFlag = tokens.some(
    (token) => APPLY_READ_FLAGS.has(flagName(token))
  );
  return !hasReadFlag;
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
      `git ${sub} is not allowed. Allowed: status, diff, log, show, branch, blame, rev-parse, ls-files, checkout, switch, add, commit, apply.`
    );
  }
  const commandArgs = argv.slice(i);
  if (sub === "branch") {
    const blocked = commandArgs.find(
      (token) => BRANCH_BLOCKED.has(flagName(token))
    );
    if (blocked) {
      throw new Error(
        `git branch option ${flagName(blocked)} is not allowed.`
      );
    }
  }
  if (sub === "apply") {
    const blocked = commandArgs.find(
      (token) => APPLY_BLOCKED.has(flagName(token))
    );
    if (blocked) {
      throw new Error(
        `git apply option ${flagName(blocked)} is not allowed.`
      );
    }
  }
  if (sub === "commit") {
    if (!hasCommitMessage(commandArgs)) {
      throw new Error('git commit requires -m "message".');
    }
    if (!commandArgs.includes("--no-verify") && !commandArgs.includes("-n")) {
      argv = [...argv, "--no-verify"];
    }
  }
  return {
    args: argv,
    needsPermission: WRITE.has(sub) || sub === "branch" && branchNeedsPermission(commandArgs) || sub === "apply" && applyNeedsPermission(commandArgs),
    title: `git ${argv.join(" ")}`
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  planGitCommand
});
//# sourceMappingURL=git-command.js.map
