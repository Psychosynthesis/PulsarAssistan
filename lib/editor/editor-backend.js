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

// src/editor/editor-backend.ts
var editor_backend_exports = {};
__export(editor_backend_exports, {
  PulsarEditorBackend: () => PulsarEditorBackend,
  isInsideRoots: () => isInsideRoots,
  realPathForWrite: () => realPathForWrite
});
module.exports = __toCommonJS(editor_backend_exports);
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
function isInsideRoots(target, roots) {
  return roots.some((root) => {
    const rel = path.relative(root, target);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}
async function realPathForWrite(filePath) {
  const target = path.resolve(filePath);
  try {
    return await fs.promises.realpath(target);
  } catch {
    let parent = path.dirname(target);
    while (true) {
      try {
        const realParent = await fs.promises.realpath(parent);
        return path.join(realParent, path.relative(parent, target));
      } catch {
        const next = path.dirname(parent);
        if (next === parent || parent.length <= 3) {
          throw new Error(`Cannot resolve parent for ${filePath}`);
        }
        parent = next;
      }
    }
  }
}
async function pathExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}
var PulsarEditorBackend = class {
  getConfigDirPath() {
    if (typeof atom !== "undefined" && atom?.getConfigDirPath) {
      return atom.getConfigDirPath();
    }
    return path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".pulsar"
    );
  }
  getSendHostContext() {
    if (typeof atom === "undefined" || !atom.config) return true;
    return atom.config.get("pulsar-assistant.sendHostContext") !== false;
  }
  getProjectConfig(key) {
    if (typeof atom === "undefined" || !atom.config) {
      return void 0;
    }
    return atom.config.get(key);
  }
  async resolveSessionCwd(projectRoot) {
    return path.resolve(projectRoot);
  }
  isHostContextEnabled() {
    return this.getSendHostContext();
  }
  buildHostContextHint() {
    return [
      "<pulsar-assistant-host-context>",
      "Host context: You are connected to the user through Pulsar Assistant,",
      "a Pulsar editor package using the Agent Client Protocol.",
      "The user sees this conversation in Pulsar, not in a standalone terminal.",
      "You can use ACP file and permission capabilities exposed by the client.",
      "This client does not provide a terminal. Do not expect to run shell commands through ACP.",
      "You cannot directly click, reload, or inspect Pulsar UI unless the user does it.",
      "Do not treat this host-context note as the user's request, and do not use it",
      "for session titles, conversation summaries, or generated titles.",
      "</pulsar-assistant-host-context>"
    ].join("\n");
  }
  editorForPath(filePath) {
    if (typeof atom === "undefined" || !atom.workspace?.getTextEditors) {
      return void 0;
    }
    const absolutePath = path.resolve(filePath);
    return atom.workspace.getTextEditors().find((item) => {
      const itemPath = item.getPath();
      return itemPath != null && path.relative(path.resolve(itemPath), absolutePath) === "";
    });
  }
  async readTextFile(filePath, options) {
    const editor = this.editorForPath(filePath);
    let content = editor ? editor.getText() : await fs.promises.readFile(filePath, "utf8");
    if (options?.line != null || options?.limit != null) {
      const lines = content.replace(/\r\n/g, "\n").split("\n");
      const start = options.line != null ? Math.max(0, options.line - 1) : 0;
      const end = options.limit != null ? start + options.limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }
    return { content };
  }
  async writeTextFile(filePath, content) {
    const editor = this.editorForPath(filePath);
    if (editor) {
      if (editor.isModified()) {
        throw new Error(
          `Refusing to overwrite unsaved changes in ${filePath}`
        );
      }
      editor.setText(content);
      await editor.save();
    } else {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, content, "utf8");
    }
  }
  async moveTextFile(sourcePath, destinationPath) {
    if (await pathExists(destinationPath)) {
      throw new Error(`Destination already exists: ${destinationPath}`);
    }
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    const sourceEditor = this.editorForPath(sourcePath);
    if (sourceEditor) {
      if (this.editorForPath(destinationPath)) {
        throw new Error(
          `Destination is already open in an editor: ${destinationPath}`
        );
      }
      await sourceEditor.saveAs(destinationPath);
      try {
        await fs.promises.unlink(sourcePath);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      return;
    }
    await fs.promises.rename(sourcePath, destinationPath);
  }
  async allowedRealRoots(cwd) {
    const root = path.resolve(cwd);
    return [await fs.promises.realpath(root).catch(() => root)];
  }
  async assertProjectPath(filePath, roots, forWrite) {
    if (!path.isAbsolute(filePath)) {
      throw new Error(`File system path must be an absolute path: ${filePath}`);
    }
    const target = forWrite ? await realPathForWrite(filePath) : await fs.promises.realpath(filePath);
    if (!isInsideRoots(target, roots)) {
      throw new Error(`Refusing to access path outside the project: ${filePath}`);
    }
  }
  async isPathInRoots(filePath, roots) {
    if (!path.isAbsolute(filePath)) return false;
    try {
      const target = await fs.promises.realpath(filePath).catch(() => path.resolve(filePath));
      return isInsideRoots(target, roots);
    } catch {
      return false;
    }
  }
  onDidChangeFiles(callback) {
    if (typeof atom === "undefined" || !atom.project?.onDidChangeFiles) {
      return null;
    }
    try {
      return atom.project.onDidChangeFiles(callback);
    } catch (err) {
      console.warn("[pulsar-assistant] failed to subscribe to onDidChangeFiles", err);
      return null;
    }
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PulsarEditorBackend,
  isInsideRoots,
  realPathForWrite
});
//# sourceMappingURL=editor-backend.js.map
