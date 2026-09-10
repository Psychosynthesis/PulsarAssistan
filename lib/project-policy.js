"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/project-policy.ts
var project_policy_exports = {};
__export(project_policy_exports, {
  CFG_PROJECTS: () => CFG_PROJECTS,
  resolveProjectPolicy: () => resolveProjectPolicy
});
module.exports = __toCommonJS(project_policy_exports);

// src/project-uri.ts
var path = __toESM(require("path"));
function normalizeProjectRoot(projectRoot) {
  return path.resolve(projectRoot);
}
function sameProjectRoot(a, b) {
  const left = normalizeProjectRoot(a);
  const right = normalizeProjectRoot(b);
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

// src/project-policy.ts
var CFG_PROJECTS = "pulsar-assistant.projects";
var DENY = {
  allowCommands: false,
  testCommand: null,
  maxTurnRequests: null
};
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalString(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed === "" ? void 0 : trimmed;
}
function positiveInt(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return null;
  }
  return Math.trunc(value);
}
function resolveProjectPolicy(projectRoot, projects) {
  if (!isObject(projects)) return DENY;
  const root = normalizeProjectRoot(projectRoot);
  for (const [key, value] of Object.entries(projects)) {
    if (!key || !isObject(value) || !sameProjectRoot(key, root)) continue;
    return {
      allowCommands: value.allowCommands === true,
      testCommand: optionalString(value.testCommand) ?? null,
      maxTurnRequests: positiveInt(value.maxTurnRequests)
    };
  }
  return DENY;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CFG_PROJECTS,
  resolveProjectPolicy
});
//# sourceMappingURL=project-policy.js.map
