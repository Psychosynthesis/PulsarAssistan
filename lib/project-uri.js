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

// src/project-uri.ts
var project_uri_exports = {};
__export(project_uri_exports, {
  PULSAR_ACP_AGENT_URI_PREFIX: () => PULSAR_ACP_AGENT_URI_PREFIX,
  normalizeProjectRoot: () => normalizeProjectRoot,
  parseAgentUri: () => parseAgentUri,
  projectFolderName: () => projectFolderName,
  resolveInsideRoot: () => resolveInsideRoot,
  sameProjectRoot: () => sameProjectRoot,
  uriForProject: () => uriForProject
});
module.exports = __toCommonJS(project_uri_exports);
var path = __toESM(require("path"));
var PULSAR_ACP_AGENT_URI_PREFIX = "atom://pulsar-assistant/project/";
function normalizeProjectRoot(projectRoot) {
  return path.resolve(projectRoot);
}
function uriForProject(projectRoot) {
  return PULSAR_ACP_AGENT_URI_PREFIX + encodeURIComponent(normalizeProjectRoot(projectRoot));
}
function parseAgentUri(uri) {
  if (!uri.startsWith(PULSAR_ACP_AGENT_URI_PREFIX)) return null;
  try {
    const decoded = decodeURIComponent(
      uri.slice(PULSAR_ACP_AGENT_URI_PREFIX.length)
    );
    if (!decoded) return null;
    return normalizeProjectRoot(decoded);
  } catch {
    return null;
  }
}
function sameProjectRoot(a, b) {
  const left = normalizeProjectRoot(a);
  const right = normalizeProjectRoot(b);
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}
function projectFolderName(projectRoot) {
  const base = path.basename(normalizeProjectRoot(projectRoot));
  return base || projectRoot;
}
function resolveInsideRoot(cwd, requested) {
  const root = path.resolve(cwd);
  const target = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the project: ${requested}`);
  }
  return target;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PULSAR_ACP_AGENT_URI_PREFIX,
  normalizeProjectRoot,
  parseAgentUri,
  projectFolderName,
  resolveInsideRoot,
  sameProjectRoot,
  uriForProject
});
//# sourceMappingURL=project-uri.js.map
