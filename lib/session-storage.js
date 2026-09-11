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

// src/session-storage.ts
var session_storage_exports = {};
__export(session_storage_exports, {
  clearSessionMessages: () => clearSessionMessages,
  deleteMessage: () => deleteMessage,
  deleteSession: () => deleteSession,
  getProjectStorageDir: () => getProjectStorageDir,
  getProjectTreePath: () => getProjectTreePath,
  getSessionsDir: () => getSessionsDir,
  listSessions: () => listSessions,
  loadSession: () => loadSession,
  safeProjectKey: () => safeProjectKey,
  saveSession: () => saveSession,
  sessionFilePath: () => sessionFilePath
});
module.exports = __toCommonJS(session_storage_exports);
var import_crypto = require("crypto");
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
function safeProjectKey(projectRoot) {
  const resolved = path.resolve(projectRoot);
  const baseName = path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, "_") || "root";
  const hash = (0, import_crypto.createHash)("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${baseName}-${hash}`;
}
function getProjectStorageDir(configDirPath, projectRoot) {
  return path.join(
    configDirPath,
    "storage",
    "pulsar-assistant",
    "projects",
    safeProjectKey(projectRoot)
  );
}
function getSessionsDir(projectStorageDir) {
  return path.join(projectStorageDir, "sessions");
}
function getProjectTreePath(projectStorageDir) {
  return path.join(projectStorageDir, "tree.json");
}
function safeSessionFileName(sessionId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Invalid sessionId: ${sessionId}`);
  }
  return `${sessionId}.json`;
}
function sessionFilePath(projectStorageDir, sessionId) {
  return path.join(getSessionsDir(projectStorageDir), safeSessionFileName(sessionId));
}
async function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.${(0, import_crypto.randomBytes)(6).toString("hex")}.tmp`;
  await fs.promises.writeFile(tempPath, data, "utf8");
  try {
    await fs.promises.rename(tempPath, filePath);
  } catch (err) {
    try {
      await fs.promises.unlink(filePath);
      await fs.promises.rename(tempPath, filePath);
    } catch {
      await fs.promises.unlink(tempPath).catch(() => {
      });
      throw err;
    }
  }
}
async function saveSession(projectStorageDir, session) {
  const target = sessionFilePath(projectStorageDir, session.id);
  session.updatedAt = Date.now();
  const json = JSON.stringify(session, null, 2);
  await atomicWriteFile(target, json);
}
async function loadSession(projectStorageDir, sessionId) {
  let target;
  try {
    target = sessionFilePath(projectStorageDir, sessionId);
  } catch {
    return null;
  }
  try {
    const raw = await fs.promises.readFile(target, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.messages)) {
      return parsed;
    }
    return null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
async function listSessions(projectStorageDir) {
  const sessionsDir = getSessionsDir(projectStorageDir);
  let entries;
  try {
    entries = await fs.promises.readdir(sessionsDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const summaries = [];
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    const sessionId = file.slice(0, -5);
    try {
      const session = await loadSession(projectStorageDir, sessionId);
      if (session) {
        summaries.push({
          id: session.id,
          title: session.title || session.id,
          projectRoot: session.projectRoot,
          agentId: session.agentId,
          model: session.model,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length
        });
      }
    } catch {
    }
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}
async function deleteSession(projectStorageDir, sessionId) {
  let target;
  try {
    target = sessionFilePath(projectStorageDir, sessionId);
  } catch {
    return false;
  }
  try {
    await fs.promises.unlink(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
async function deleteMessage(projectStorageDir, sessionId, messageId) {
  const session = await loadSession(projectStorageDir, sessionId);
  if (!session) return false;
  const initialLength = session.messages.length;
  session.messages = session.messages.filter((m) => m.id !== messageId);
  if (session.messages.length === initialLength) return false;
  await saveSession(projectStorageDir, session);
  return true;
}
async function clearSessionMessages(projectStorageDir, sessionId) {
  const session = await loadSession(projectStorageDir, sessionId);
  if (!session) return false;
  session.messages = session.messages.filter((m) => m.role === "system");
  await saveSession(projectStorageDir, session);
  return true;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  clearSessionMessages,
  deleteMessage,
  deleteSession,
  getProjectStorageDir,
  getProjectTreePath,
  getSessionsDir,
  listSessions,
  loadSession,
  safeProjectKey,
  saveSession,
  sessionFilePath
});
//# sourceMappingURL=session-storage.js.map
