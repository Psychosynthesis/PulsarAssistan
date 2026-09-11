import * as fs from "fs";
import * as path from "path";
import {
  DEFAULT_PROJECT_SKIP_DIRS,
  ProjectFileTree,
  toPosixPath,
} from "../file-btree";
import {
  getProjectStorageDir,
  getProjectTreePath,
} from "../session-storage";
import type { EditorBackend, FileChangeEvent } from "../editor";

export class ProjectFileTreeManager {
  private fileTree: ProjectFileTree;
  private fileTreeSubscription: { dispose: () => void } | null = null;
  private pendingFileTreeUpdates = new Set<string>();
  private fileTreeBatchTimer: NodeJS.Timeout | null = null;
  private fileTreeSaveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly editor: EditorBackend,
  ) {
    this.fileTree = new ProjectFileTree(this.projectRoot);
    void this.initFileTree();
    this.subscribeToFileEvents();
  }

  getFileTree(): ProjectFileTree {
    return this.fileTree;
  }

  getStorageDir(): string {
    const configDir = this.editor.getConfigDirPath();
    return getProjectStorageDir(configDir, this.projectRoot);
  }

  private treeFilePath(): string {
    return getProjectTreePath(this.getStorageDir());
  }

  private async initFileTree(): Promise<void> {
    const treePath = this.treeFilePath();
    try {
      const loaded = await ProjectFileTree.loadFromFile(treePath);
      if (loaded) {
        this.fileTree = loaded;
        return;
      }
    } catch (err) {
      console.warn("[pulsar-assistant] failed to load tree.json, rescanning", err);
    }

    try {
      await this.fileTree.scanProject();
      await this.fileTree.saveToFile(treePath);
    } catch (err) {
      console.warn("[pulsar-assistant] background file tree scan failed", err);
    }
  }

  private isPathInProject(targetPath: string): boolean {
    const rel = path.relative(this.projectRoot, targetPath);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  private isPathIgnored(targetPath: string): boolean {
    const rel = toPosixPath(path.relative(this.projectRoot, targetPath));
    const segments = rel.split("/");
    for (const seg of segments) {
      if (DEFAULT_PROJECT_SKIP_DIRS.has(seg)) return true;
    }
    return false;
  }

  private subscribeToFileEvents(): void {
    const sub = this.editor.onDidChangeFiles((events: FileChangeEvent[]) => {
      this.handleFileEvents(events);
    });
    if (sub) {
      this.fileTreeSubscription = sub;
    }
  }

  private handleFileEvents(events: FileChangeEvent[]): void {
    let hasProjectChanges = false;
    for (const event of events) {
      if (
        event.oldPath &&
        this.isPathInProject(event.oldPath) &&
        !this.isPathIgnored(event.oldPath)
      ) {
        this.pendingFileTreeUpdates.add(event.oldPath);
        hasProjectChanges = true;
      }
      if (
        event.path &&
        this.isPathInProject(event.path) &&
        !this.isPathIgnored(event.path)
      ) {
        this.pendingFileTreeUpdates.add(event.path);
        hasProjectChanges = true;
      }
    }
    if (hasProjectChanges) {
      this.scheduleBatchTreeUpdates();
    }
  }

  private scheduleBatchTreeUpdates(): void {
    if (this.fileTreeBatchTimer) {
      clearTimeout(this.fileTreeBatchTimer);
    }
    this.fileTreeBatchTimer = setTimeout(() => {
      this.fileTreeBatchTimer = null;
      void this.processBatchTreeUpdates();
    }, 1500);
  }

  private async processBatchTreeUpdates(): Promise<void> {
    if (this.pendingFileTreeUpdates.size === 0) return;
    const pathsToProcess = Array.from(this.pendingFileTreeUpdates);
    this.pendingFileTreeUpdates.clear();

    for (const p of pathsToProcess) {
      try {
        await this.fileTree.updatePath(p);
      } catch {
        // Ignore single path update failure
      }
    }

    this.scheduleTreeSave();
  }

  async notifyPathModified(filePath: string): Promise<void> {
    try {
      await this.fileTree.updatePath(filePath);
    } catch {
      // Ignore update error
    }
    this.scheduleTreeSave();
  }

  scheduleTreeSave(): void {
    if (this.fileTreeSaveTimer) {
      clearTimeout(this.fileTreeSaveTimer);
    }
    this.fileTreeSaveTimer = setTimeout(() => {
      this.fileTreeSaveTimer = null;
      void this.saveTreeToDisk();
    }, 2500);
  }

  private async saveTreeToDisk(): Promise<void> {
    const treePath = this.treeFilePath();
    try {
      await this.fileTree.saveToFile(treePath);
    } catch (err) {
      console.warn("[pulsar-assistant] failed to save tree.json", err);
    }
  }

  dispose(): void {
    if (this.fileTreeSubscription) {
      try {
        this.fileTreeSubscription.dispose();
      } catch {}
      this.fileTreeSubscription = null;
    }
    if (this.fileTreeBatchTimer) {
      clearTimeout(this.fileTreeBatchTimer);
      this.fileTreeBatchTimer = null;
    }
    if (this.fileTreeSaveTimer) {
      clearTimeout(this.fileTreeSaveTimer);
      this.fileTreeSaveTimer = null;
    }
    if (this.pendingFileTreeUpdates.size > 0) {
      for (const p of this.pendingFileTreeUpdates) {
        try {
          const fullPath = path.isAbsolute(p) ? p : path.join(this.projectRoot, p);
          const stat = fs.statSync(fullPath);
          const rel = toPosixPath(path.relative(this.projectRoot, fullPath));
          this.fileTree.set(rel, {
            path: rel,
            size: stat.size,
            mtime: stat.mtimeMs,
            isDirectory: stat.isDirectory(),
          });
        } catch {
          const rel = toPosixPath(path.relative(this.projectRoot, p));
          this.fileTree.remove(rel);
        }
      }
      this.pendingFileTreeUpdates.clear();
    }
    void this.saveTreeToDisk();
  }
}
