import * as path from "path";
import * as acp from "@agentclientprotocol/sdk";
import {
  buildContextBlock,
  ContextAttachment,
} from "../util";
import type { LaunchTarget } from "../agent-config";
import type { StoredContextMessage } from "../session-storage";
import { EditorBackend, PulsarEditorBackend } from "../editor";
import { ProjectFileTree } from "../file-btree";
import { ProjectFileTreeManager } from "./file-tree-manager";
import {
  AgentBackend,
  AcpCliBackend,
  BuiltinBackend,
} from "./backends";
import {
  AgentEvent,
  Listener,
  StartupCancelled,
  isStartupCancellation,
} from "./types";

export type { AgentEvent, Listener, LaunchTarget };
export { StartupCancelled, isStartupCancellation };

export class AgentSession {
  private listeners = new Set<Listener>();
  private backend: AgentBackend | null = null;
  private fileTreeManager: ProjectFileTreeManager;
  private readonly editor: EditorBackend;

  running = false;
  switching = false;
  private starting: Promise<void> | null = null;
  private launchTarget: LaunchTarget | null = null;
  private startedTarget: LaunchTarget | null = null;
  private sessionListGeneration = 0;

  constructor(
    private readonly projectRoot: string,
    editor?: EditorBackend,
  ) {
    if (!path.isAbsolute(projectRoot)) {
      throw new Error(
        `Pulsar Assistant project folder must be an absolute path: ${projectRoot}`,
      );
    }
    this.editor = editor ?? new PulsarEditorBackend();
    this.fileTreeManager = new ProjectFileTreeManager(
      this.projectRoot,
      this.editor,
    );
  }

  get sessionId(): string | null {
    return this.backend?.sessionId ?? null;
  }

  getFileTree(): ProjectFileTree {
    return this.fileTreeManager.getFileTree();
  }

  onEvent(callback: Listener): { dispose: () => void } {
    this.listeners.add(callback);
    return { dispose: () => this.listeners.delete(callback) };
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[pulsar-assistant] event listener failed", error);
      }
    }
  }

  get launchedAgent(): LaunchTarget | null {
    return this.startedTarget;
  }

  get currentTarget(): LaunchTarget | null {
    return this.launchTarget;
  }

  setModel(model: string): void {
    if (this.launchTarget && this.launchTarget.kind === "openai") {
      this.launchTarget = { ...this.launchTarget, model };
    }
    if (this.startedTarget && this.startedTarget.kind === "openai") {
      this.startedTarget = { ...this.startedTarget, model };
    }
    if (this.backend) {
      this.backend.setModel(model);
    }
  }

  start(target: LaunchTarget): Promise<void> {
    if (this.sessionId) {
      if (this.launchTarget?.id === target.id) return Promise.resolve();
      return Promise.reject(
        new Error("Cannot switch agents on a live session."),
      );
    }
    if (this.starting) {
      if (this.launchTarget?.id === target.id) return this.starting;
      return Promise.reject(
        new Error("The agent is still starting; try again."),
      );
    }
    this.launchTarget = target;
    const pending = this._start().catch((error) => {
      if (this.starting === pending) this.cleanupFailedStartup();
      throw error;
    });
    this.starting = pending;
    return pending;
  }

  private async _start(): Promise<void> {
    const target = this.launchTarget;
    if (!target) throw new Error("No agent configured.");
    this.startedTarget = target;
    this.teardownBackend();

    const cwd = await this.editor.resolveSessionCwd(this.projectRoot);

    if (target.kind === "openai") {
      this.backend = new BuiltinBackend(
        target,
        this.projectRoot,
        this.editor,
        this.fileTreeManager,
        (event: AgentEvent) => this.emit(event),
      );
    } else {
      this.backend = new AcpCliBackend(
        target,
        this.projectRoot,
        this.editor,
        this.fileTreeManager,
        (event: AgentEvent) => this.emit(event),
        (code, signal) => this.emit({ type: "exit", code, signal }),
      );
    }

    await this.backend.start(cwd);
    this.starting = null;

    this.emit({
      type: "ready",
      source: "start",
    });
    this.refreshSessionList();
  }

  private cleanupFailedStartup(): void {
    this.starting = null;
    this.startedTarget = null;
    this.teardownBackend();
  }

  private teardownBackend(): void {
    if (this.backend) {
      this.backend.dispose();
      this.backend = null;
    }
  }

  currentSessionConfigOptions(): acp.SessionConfigOption[] | null {
    return this.backend?.currentSessionConfigOptions() ?? null;
  }

  currentAvailableCommands(): acp.AvailableCommand[] {
    return this.backend?.currentAvailableCommands() ?? [];
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.backend) {
      throw new Error("Agent is not connected.");
    }
    await this.backend.setConfigOption(configId, value);
  }

  async prompt(
    text: string,
    attachments: ContextAttachment[] = [],
  ): Promise<acp.PromptResponse> {
    if (this.running) {
      throw new Error("The agent is already responding.");
    }
    if (!this.backend || !this.sessionId) {
      throw new Error("Agent session is not ready.");
    }
    this.running = true;
    this.emit({ type: "turn-start" });
    let response: acp.PromptResponse | undefined;
    try {
      const blocks: acp.ContentBlock[] = [];
      const includeHostContext =
        this.backend.supportsEmbeddedContext() &&
        this.editor.isHostContextEnabled();

      if (includeHostContext) {
        const hint = this.editor.buildHostContextHint();
        if (hint) {
          blocks.push({ type: "text", text: hint });
        }
      }

      for (const att of attachments) {
        blocks.push(buildContextBlock(att));
      }

      if (text.length > 0) {
        blocks.push({ type: "text", text });
      }

      response = await this.backend.prompt(blocks);
      this.refreshSessionList();
      return response;
    } finally {
      this.running = false;
      this.emit({ type: "turn-end", stopReason: response?.stopReason });
    }
  }

  cancel(): void {
    this.running = false;
    this.backend?.cancel();
  }

  supportsImages(): boolean {
    return this.backend?.supportsImages() ?? false;
  }

  supportsEmbeddedContext(): boolean {
    return this.backend?.supportsEmbeddedContext() ?? false;
  }

  async isPathInProjectRoots(filePath: string): Promise<boolean> {
    if (!path.isAbsolute(filePath)) return false;
    const base = this.backend?.sessionCwd ?? this.projectRoot;
    const roots = await this.editor.allowedRealRoots(base);
    return this.editor.isPathInRoots(filePath, roots);
  }

  private async assertSessionCwdAllowed(
    cwd: string,
    action: "load" | "delete",
  ): Promise<void> {
    if (!path.isAbsolute(cwd)) {
      throw new Error(
        `Refusing to ${action} session with non-absolute working directory: ${cwd}`,
      );
    }
    const roots = await this.editor.allowedRealRoots(
      this.backend?.sessionCwd ?? this.projectRoot,
    );
    if (!(await this.editor.isPathInRoots(cwd, roots))) {
      throw new Error(`Refusing to ${action} session outside the project: ${cwd}`);
    }
  }

  canListSessions(): boolean {
    return this.backend?.canListSessions() ?? false;
  }

  canLoadSession(): boolean {
    return this.backend?.canLoadSession() ?? false;
  }

  canDeleteSession(): boolean {
    return this.backend?.canDeleteSession() ?? false;
  }

  isSessionLoaded(id: string): boolean {
    return this.backend?.isSessionLoaded(id) ?? false;
  }

  async deleteSession(
    id: string,
    cwd?: string,
  ): Promise<{ deletedActive: boolean }> {
    if (!this.backend) throw new Error("Agent is not connected.");
    if (!this.canDeleteSession()) {
      throw new Error("The agent does not support deleting sessions.");
    }
    if (this.running || this.switching) {
      throw new Error("The agent is already responding.");
    }

    this.switching = true;
    try {
      const deletedActive = id === this.sessionId;
      const scopedCwd =
        cwd ?? (deletedActive ? this.backend.sessionCwd : null);
      if (!scopedCwd) {
        throw new Error(
          `Refusing to delete session without a known working directory: ${id}`,
        );
      }
      await this.assertSessionCwdAllowed(scopedCwd, "delete");
      const result = await this.backend.deleteSession(id, scopedCwd);
      this.refreshSessionList();
      return result;
    } finally {
      this.switching = false;
    }
  }

  async newSession(): Promise<void> {
    if (this.running || this.switching) {
      throw new Error("The agent is already responding.");
    }
    if (!this.backend) {
      throw new Error("Agent is not connected.");
    }
    this.switching = true;
    try {
      const cwd = await this.editor.resolveSessionCwd(
        this.backend.sessionCwd ?? this.projectRoot,
      );
      await this.backend.newSession(cwd);
      this.switching = false;
      this.emit({ type: "ready", source: "new" });
      this.refreshSessionList();
    } finally {
      this.switching = false;
    }
  }

  activateCachedSession(id: string): void {
    if (!this.backend) return;
    this.backend.activateCachedSession(id);
    this.emit({ type: "ready", source: "load" });
    this.refreshSessionList();
  }

  async loadSession(id: string, cwd?: string): Promise<void> {
    if (this.running || this.switching) {
      throw new Error("The agent is already responding.");
    }
    if (!this.backend) {
      throw new Error("Agent is not connected.");
    }
    if (!this.canLoadSession()) {
      throw new Error("The agent does not support loading sessions.");
    }

    this.switching = true;
    try {
      const scopedCwd =
        cwd ?? (await this.editor.resolveSessionCwd(this.projectRoot));
      await this.assertSessionCwdAllowed(scopedCwd, "load");
      await this.backend.loadSession(id, scopedCwd);
      this.switching = false;
      this.emit({ type: "ready", source: "load" });
      this.refreshSessionList();
    } finally {
      this.switching = false;
    }
  }

  refreshSessionList(): void {
    if (!this.canListSessions()) return;
    this.listSessions().catch((error) => {
      console.error("[pulsar-assistant] session/list failed", error);
    });
  }

  async listSessions(): Promise<void> {
    if (!this.backend || !this.canListSessions()) return;
    const generation = ++this.sessionListGeneration;
    const cwd = this.backend.sessionCwd ?? this.projectRoot;
    const sessions = await this.backend.listSessions(cwd);
    if (generation !== this.sessionListGeneration) return;
    this.emit({ type: "session-list", sessions });
  }

  getSessionMessages(sessionId?: string): StoredContextMessage[] {
    return this.backend?.getSessionMessages?.() ?? [];
  }

  async compactContext(sessionId?: string): Promise<{ compactedCount: number }> {
    if (this.backend?.compactContext) {
      return this.backend.compactContext();
    }
    return { compactedCount: 0 };
  }

  dispose(): void {
    this.fileTreeManager.dispose();
    this.cancel();
    this.teardownBackend();
    this.listeners.clear();
  }
}
