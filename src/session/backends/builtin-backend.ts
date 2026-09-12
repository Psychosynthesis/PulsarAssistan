import * as acp from "@agentclientprotocol/sdk";
import type { OpenaiLaunchTarget } from "../../agent-config";
import { BuiltinAgent } from "../../builtin/agent";
import type { BuiltinHost } from "../../builtin/tools";
import { CFG_PROJECTS, resolveProjectPolicy } from "../../project-policy";
import type { EditorBackend } from "../../editor";
import type { ProjectFileTreeManager } from "../file-tree-manager";
import type { AgentEvent } from "../types";
import { CLIENT_INFO, PROTOCOL_VERSION } from "../constants";
import type { AgentBackend, BackendInitResult } from "./backend";
import type { StoredContextMessage } from "../../session-storage";

export class BuiltinBackend implements AgentBackend {
  private builtin: BuiltinAgent | null = null;
  sessionId: string | null = null;
  sessionCwd: string | null = null;
  private loadedSessionIds = new Set<string>();
  private permissionResolvers = new Set<
    (outcome: acp.RequestPermissionResponse) => void
  >();

  constructor(
    public target: OpenaiLaunchTarget,
    private readonly projectRoot: string,
    private readonly editor: EditorBackend,
    private readonly fileTreeManager: ProjectFileTreeManager,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  async start(cwd: string): Promise<BackendInitResult> {
    const builtin = new BuiltinAgent(
      this.builtinHost(),
      this.target,
      () =>
        resolveProjectPolicy(
          this.projectRoot,
          this.editor.getProjectConfig(CFG_PROJECTS),
        ),
      this.fileTreeManager.getStorageDir(),
      () => this.fileTreeManager.getFileTree(),
    );
    this.builtin = builtin;

    const init = builtin.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: CLIENT_INFO,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });

    this.emit({
      type: "initialized",
      info: init.agentInfo ?? null,
      capabilities: init.agentCapabilities ?? null,
      supportsImages: false,
    });

    const storedSessions = await builtin.listSessions();
    let sessionId: string;
    if (storedSessions.length > 0) {
      const latest = storedSessions[0];
      this.sessionId = latest.id;
      this.sessionCwd = latest.projectRoot;
      this.loadedSessionIds.add(latest.id);
      await builtin.loadSession(latest.id);
      sessionId = latest.id;
    } else {
      const session = await builtin.newSession({ cwd, mcpServers: [] });
      this.sessionId = session.sessionId;
      this.sessionCwd = cwd;
      this.loadedSessionIds.add(session.sessionId);
      sessionId = session.sessionId;
    }

    return {
      sessionId,
      cwd: this.sessionCwd,
      configOptions: null,
    };
  }

  setModel(model: string): void {
    this.target = { ...this.target, model };
    if (this.builtin) {
      this.builtin.setModel(model);
    }
  }

  supportsImages(): boolean {
    return false;
  }

  supportsEmbeddedContext(): boolean {
    return false;
  }

  canListSessions(): boolean {
    return true;
  }

  canLoadSession(): boolean {
    return true;
  }

  canDeleteSession(): boolean {
    return true;
  }

  isSessionLoaded(id: string): boolean {
    return this.loadedSessionIds.has(id);
  }

  activateCachedSession(id: string): void {
    this.sessionId = id;
  }

  currentSessionConfigOptions(): acp.SessionConfigOption[] | null {
    return null;
  }

  currentAvailableCommands(): acp.AvailableCommand[] {
    return [];
  }

  async setConfigOption(): Promise<void> {
    throw new Error("API agents do not have ACP session config options.");
  }

  async prompt(prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    if (!this.builtin || !this.sessionId) {
      throw new Error("Agent session is not ready.");
    }
    return this.builtin.prompt({ sessionId: this.sessionId, prompt });
  }

  cancel(): void {
    if (this.builtin && this.sessionId) {
      try {
        void this.builtin.cancel({ sessionId: this.sessionId });
      } catch {}
    }
    this.cancelPendingPermissions();
  }

  async newSession(cwd: string): Promise<acp.NewSessionResponse> {
    if (!this.builtin) {
      throw new Error("Agent is not connected.");
    }
    const session = await this.builtin.newSession({ cwd, mcpServers: [] });
    this.sessionId = session.sessionId;
    this.sessionCwd = cwd;
    this.loadedSessionIds.add(session.sessionId);
    return session;
  }

  async loadSession(id: string, cwd: string): Promise<void> {
    if (!this.builtin) {
      throw new Error("Agent is not connected.");
    }
    this.sessionId = id;
    await this.builtin.loadSession(id);
    this.sessionCwd = cwd;
    this.loadedSessionIds.add(id);
  }

  async deleteSession(
    id: string,
    cwd: string,
  ): Promise<{ deletedActive: boolean }> {
    if (!this.builtin) {
      throw new Error("Agent is not connected.");
    }
    const deletedActive = id === this.sessionId;
    await this.builtin.deleteSession(id);
    this.loadedSessionIds.delete(id);
    if (deletedActive) {
      this.sessionId = null;
    }
    return { deletedActive };
  }

  async listSessions(cwd: string): Promise<acp.SessionInfo[]> {
    if (!this.builtin) return [];
    const summaries = await this.builtin.listSessions();
    return summaries.map((s) => ({
      sessionId: s.id,
      cwd: s.projectRoot,
      title: s.title,
      updatedAt: new Date(s.updatedAt).toISOString(),
    }));
  }

  getSessionMessages(): StoredContextMessage[] {
    if (!this.builtin || !this.sessionId) return [];
    return this.builtin.getSessionMessages(this.sessionId);
  }

  async compactContext(): Promise<{ compactedCount: number }> {
    if (!this.builtin || !this.sessionId) return { compactedCount: 0 };
    return this.builtin.compactContext(this.sessionId);
  }

  private cancelPendingPermissions(): void {
    if (this.permissionResolvers.size === 0) return;
    for (const resolve of this.permissionResolvers) {
      resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionResolvers.clear();
    this.emit({ type: "permissions-cancelled" });
  }

  private assertSessionId(sessionId: acp.SessionId): void {
    if (this.sessionId === sessionId) return;
    throw new acp.RequestError(
      -32002,
      `Rejecting request for unknown ACP session: ${sessionId}`,
    );
  }

  private async assertProjectPath(
    filePath: string,
    forWrite: boolean,
  ): Promise<void> {
    const roots = await this.editor.allowedRealRoots(
      this.sessionCwd ?? this.projectRoot,
    );
    await this.editor.assertProjectPath(filePath, roots, forWrite);
  }

  private builtinHost(): BuiltinHost {
    return {
      sessionUpdate: async (params) => {
        if (params.sessionId !== this.sessionId) return;
        this.emit({
          type: "update",
          sessionId: params.sessionId,
          update: params.update,
        });
      },
      requestPermission: (params) => {
        this.assertSessionId(params.sessionId);
        return new Promise((resolve) => {
          const respond = (outcome: acp.RequestPermissionResponse) => {
            this.permissionResolvers.delete(respond);
            resolve(outcome);
          };
          this.permissionResolvers.add(respond);
          this.emit({ type: "permission", params, respond });
        });
      },
      readTextFile: async (params) => {
        this.assertSessionId(params.sessionId);
        await this.assertProjectPath(params.path, false);
        return this.editor.readTextFile(params.path, {
          line: params.line,
          limit: params.limit,
        });
      },
      writeTextFile: async (params) => {
        this.assertSessionId(params.sessionId);
        await this.assertProjectPath(params.path, true);
        await this.editor.writeTextFile(params.path, params.content);
        await this.fileTreeManager.notifyPathModified(params.path);
        this.emit({ type: "file-written", path: params.path });
        return {};
      },
      moveTextFile: async (params) => {
        this.assertSessionId(params.sessionId);
        await this.assertProjectPath(params.sourcePath, false);
        await this.assertProjectPath(params.destinationPath, true);
        await this.editor.moveTextFile(params.sourcePath, params.destinationPath);
        await this.fileTreeManager.notifyPathModified(params.sourcePath);
        await this.fileTreeManager.notifyPathModified(params.destinationPath);
        this.emit({ type: "file-written", path: params.destinationPath });
      },
      onStatusNote: (text: string) => {
        this.emit({ type: "status-note", text });
      },
      onThought: (text: string) => {
        this.emit({ type: "thought", text });
      },
    };
  }

  dispose(): void {
    this.cancel();
    this.builtin = null;
    this.sessionId = null;
    this.sessionCwd = null;
    this.loadedSessionIds.clear();
  }
}
