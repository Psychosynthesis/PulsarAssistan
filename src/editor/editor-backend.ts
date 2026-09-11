import * as fs from "fs";
import * as path from "path";
import type { TextEditor } from "atom";

// True when `target` is one of `roots` or nested beneath one of them.
export function isInsideRoots(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, target);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

export async function realPathForWrite(filePath: string): Promise<string> {
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

export type FileChangeEvent = {
  action: string;
  path: string;
  oldPath?: string;
};

export interface EditorBackend {
  getConfigDirPath(): string;
  getSendHostContext(): boolean;
  getProjectConfig<T = unknown>(key: string): T;

  resolveSessionCwd(projectRoot: string): Promise<string>;
  isHostContextEnabled(): boolean;
  buildHostContextHint(): string;

  readTextFile(
    filePath: string,
    options?: { line?: number | null; limit?: number | null },
  ): Promise<{ content: string }>;

  writeTextFile(filePath: string, content: string): Promise<void>;
  moveTextFile(sourcePath: string, destinationPath: string): Promise<void>;

  allowedRealRoots(cwd: string): Promise<string[]>;
  assertProjectPath(filePath: string, roots: string[], forWrite: boolean): Promise<void>;
  isPathInRoots(filePath: string, roots: string[]): Promise<boolean>;

  onDidChangeFiles(
    callback: (events: FileChangeEvent[]) => void,
  ): { dispose: () => void } | null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class PulsarEditorBackend implements EditorBackend {
  getConfigDirPath(): string {
    if (typeof atom !== "undefined" && atom?.getConfigDirPath) {
      return atom.getConfigDirPath();
    }
    return path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".pulsar",
    );
  }

  getSendHostContext(): boolean {
    if (typeof atom === "undefined" || !atom.config) return true;
    return atom.config.get("pulsar-assistant.sendHostContext") !== false;
  }

  getProjectConfig<T = unknown>(key: string): T {
    if (typeof atom === "undefined" || !atom.config) {
      return undefined as T;
    }
    return atom.config.get(key) as T;
  }

  async resolveSessionCwd(projectRoot: string): Promise<string> {
    return path.resolve(projectRoot);
  }

  isHostContextEnabled(): boolean {
    return this.getSendHostContext();
  }

  buildHostContextHint(): string {
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
      "</pulsar-assistant-host-context>",
    ].join("\n");
  }

  private editorForPath(filePath: string): TextEditor | undefined {
    if (typeof atom === "undefined" || !atom.workspace?.getTextEditors) {
      return undefined;
    }
    const absolutePath = path.resolve(filePath);
    return atom.workspace.getTextEditors().find((item) => {
      const itemPath = item.getPath();
      return (
        itemPath != null &&
        path.relative(path.resolve(itemPath), absolutePath) === ""
      );
    });
  }

  async readTextFile(
    filePath: string,
    options?: { line?: number | null; limit?: number | null },
  ): Promise<{ content: string }> {
    const editor = this.editorForPath(filePath);
    let content: string = editor
      ? editor.getText()
      : await fs.promises.readFile(filePath, "utf8");

    if (options?.line != null || options?.limit != null) {
      const lines = content.replace(/\r\n/g, "\n").split("\n");
      const start = options.line != null ? Math.max(0, options.line - 1) : 0;
      const end =
        options.limit != null ? start + options.limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }
    return { content };
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    const editor = this.editorForPath(filePath);
    if (editor) {
      if (editor.isModified()) {
        throw new Error(
          `Refusing to overwrite unsaved changes in ${filePath}`,
        );
      }
      editor.setText(content);
      await editor.save();
    } else {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, content, "utf8");
    }
  }

  async moveTextFile(
    sourcePath: string,
    destinationPath: string,
  ): Promise<void> {
    if (await pathExists(destinationPath)) {
      throw new Error(`Destination already exists: ${destinationPath}`);
    }

    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });

    const sourceEditor = this.editorForPath(sourcePath);
    if (sourceEditor) {
      if (this.editorForPath(destinationPath)) {
        throw new Error(
          `Destination is already open in an editor: ${destinationPath}`,
        );
      }
      await sourceEditor.saveAs(destinationPath);
      try {
        await fs.promises.unlink(sourcePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      return;
    }

    await fs.promises.rename(sourcePath, destinationPath);
  }

  async allowedRealRoots(cwd: string): Promise<string[]> {
    const root = path.resolve(cwd);
    return [await fs.promises.realpath(root).catch(() => root)];
  }

  async assertProjectPath(
    filePath: string,
    roots: string[],
    forWrite: boolean,
  ): Promise<void> {
    if (!path.isAbsolute(filePath)) {
      throw new Error(`File system path must be an absolute path: ${filePath}`);
    }
    const target = forWrite
      ? await realPathForWrite(filePath)
      : await fs.promises.realpath(filePath);
    if (!isInsideRoots(target, roots)) {
      throw new Error(`Refusing to access path outside the project: ${filePath}`);
    }
  }

  async isPathInRoots(filePath: string, roots: string[]): Promise<boolean> {
    if (!path.isAbsolute(filePath)) return false;
    try {
      const target = await fs.promises
        .realpath(filePath)
        .catch(() => path.resolve(filePath));
      return isInsideRoots(target, roots);
    } catch {
      return false;
    }
  }

  onDidChangeFiles(
    callback: (events: FileChangeEvent[]) => void,
  ): { dispose: () => void } | null {
    if (typeof atom === "undefined" || !(atom.project as any)?.onDidChangeFiles) {
      return null;
    }
    try {
      return (atom.project as any).onDidChangeFiles(callback);
    } catch (err) {
      console.warn("[pulsar-assistant] failed to subscribe to onDidChangeFiles", err);
      return null;
    }
  }
}
