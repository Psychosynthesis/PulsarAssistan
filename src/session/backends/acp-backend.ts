import { ChildProcess } from "child_process";
import spawn from "cross-spawn";
import * as path from "path";
import { Readable, Writable } from "stream";
import * as acp from "@agentclientprotocol/sdk";
import type { LaunchTarget } from "../../agent-config";
import { parseCommandLine, classifyAuthMethods } from "../../util";
import type { EditorBackend } from "../../editor";
import type { ProjectFileTreeManager } from "../file-tree-manager";
import {
  AgentEvent,
  AuthChoice,
  StartupCancelled,
} from "../types";
import {
  AUTH_REQUIRED_CODE,
  CLIENT_INFO,
  HOST_CONTEXT_END,
  HOST_CONTEXT_META,
  HOST_CONTEXT_START,
  HOST_CONTEXT_TEXT,
  PROTOCOL_VERSION,
  STARTUP_TIMEOUT_MS,
} from "../constants";
import type { AgentBackend, BackendInitResult } from "./backend";

function terminalAuthCommand(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const meta = raw as { command?: unknown; args?: unknown };
  if (typeof meta.command !== "string") return null;
  const args = Array.isArray(meta.args)
    ? meta.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return [meta.command, ...args].join(" ");
}

function rpcError(message: string, code: number): Error {
  return new acp.RequestError(code, message);
}

export class AcpCliBackend implements AgentBackend {
  private child: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;
  sessionId: string | null = null;
  sessionCwd: string | null = null;
  private pendingSessionId: string | null = null;
  private sessionListGeneration = 0;
  private authMethods: acp.AuthMethod[] = [];
  private agentCapabilities: acp.AgentCapabilities | null = null;
  private promptCapabilities: acp.PromptCapabilities | null = null;
  private permissionResolvers = new Set<
    (outcome: acp.RequestPermissionResponse) => void
  >();
  private authChoiceResolve: ((choice: AuthChoice) => void) | null = null;
  private loadedSessionIds = new Set<string>();
  private hostContextSentSessionIds = new Set<string>();
  private sessionConfigOptions = new Map<string, acp.SessionConfigOption[]>();
  private sessionCommands = new Map<string, acp.AvailableCommand[]>();
  private lastStderr = "";
  private startingPromise: Promise<BackendInitResult> | null = null;

  constructor(
    public readonly target: Extract<LaunchTarget, { kind: "acp" }>,
    private readonly projectRoot: string,
    private readonly editor: EditorBackend,
    private readonly fileTreeManager: ProjectFileTreeManager,
    private readonly emit: (event: AgentEvent) => void,
    private readonly onExit: (code: number | null, signal: string | null) => void,
  ) {}

  supportsImages(): boolean {
    return this.promptCapabilities?.image === true;
  }

  supportsEmbeddedContext(): boolean {
    return this.promptCapabilities?.embeddedContext === true;
  }

  canListSessions(): boolean {
    return this.agentCapabilities?.sessionCapabilities?.list != null;
  }

  canLoadSession(): boolean {
    return this.agentCapabilities?.loadSession === true;
  }

  canDeleteSession(): boolean {
    return this.agentCapabilities?.sessionCapabilities?.delete != null;
  }

  isSessionLoaded(id: string): boolean {
    return this.loadedSessionIds.has(id);
  }

  activateCachedSession(id: string): void {
    this.sessionId = id;
  }

  currentSessionConfigOptions(): acp.SessionConfigOption[] | null {
    if (!this.sessionId) return null;
    return this.sessionConfigOptions.get(this.sessionId) ?? null;
  }

  currentAvailableCommands(): acp.AvailableCommand[] {
    if (!this.sessionId) return [];
    return this.sessionCommands.get(this.sessionId) ?? [];
  }

  setModel(): void {
    // ACP CLIs do not support on-the-fly setModel
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error("Agent session is not ready.");
    }
    const sessionId = this.sessionId;
    const result = await this.connection.setSessionConfigOption({
      sessionId,
      configId,
      value,
    });
    if (this.loadedSessionIds.has(sessionId)) {
      this.sessionConfigOptions.set(sessionId, result.configOptions);
    }
  }

  async start(cwd: string): Promise<BackendInitResult> {
    const pending = this.doStart(cwd);
    this.startingPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.startingPromise === pending) {
        this.startingPromise = null;
      }
    }
  }

  private async doStart(cwd: string): Promise<BackendInitResult> {
    const { connection, processError } = this.spawnCommand(cwd);
    this.connection = connection;

    const init = await this.withStartupTimeout(
      Promise.race([
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: CLIENT_INFO,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: false,
          },
        }),
        processError,
      ]),
      "initialize",
    );

    if (init.protocolVersion !== PROTOCOL_VERSION) {
      this.teardownProcess();
      throw new Error(
        `Unsupported ACP protocol version ${init.protocolVersion}; expected ${PROTOCOL_VERSION}.`,
      );
    }

    this.authMethods = init.authMethods || [];
    this.agentCapabilities = init.agentCapabilities ?? null;
    this.promptCapabilities = init.agentCapabilities?.promptCapabilities ?? null;

    this.emit({
      type: "initialized",
      info: init.agentInfo ?? null,
      capabilities: this.agentCapabilities,
      supportsImages: this.promptCapabilities?.image === true,
    });

    let session: acp.NewSessionResponse;
    try {
      session = await this.newSessionWithTimeout(connection, cwd, processError);
    } catch (error) {
      if (
        !(
          error instanceof acp.RequestError &&
          error.code === AUTH_REQUIRED_CODE
        )
      ) {
        throw error;
      }
      const method = await this.resolveAuthMethod(processError);
      this.emit({
        type: "status",
        text: `Authenticating: ${method.name}\u2026`,
      });
      try {
        await this.authenticateWithTimeout(connection, method.id, processError);
      } catch (authError) {
        throw new Error(this.loginHint(method, authError));
      }
      try {
        session = await this.newSessionWithTimeout(
          connection,
          cwd,
          processError,
        );
      } catch (retryError) {
        if (
          retryError instanceof acp.RequestError &&
          retryError.code === AUTH_REQUIRED_CODE
        ) {
          throw new Error(this.loginHint(method, retryError));
        }
        throw retryError;
      }
    }

    this.sessionId = session.sessionId;
    this.sessionCwd = cwd;
    this.loadedSessionIds.add(session.sessionId);
    if (session.configOptions) {
      this.sessionConfigOptions.set(session.sessionId, session.configOptions);
    }

    return {
      sessionId: session.sessionId,
      cwd,
      configOptions: session.configOptions,
    };
  }

  private spawnCommand(
    cwd: string,
  ): { connection: acp.ClientSideConnection; processError: Promise<never> } {
    const [command, ...args] = parseCommandLine(this.target.command);
    if (!command) {
      throw new Error("No agent command configured. Edit agents to set one.");
    }
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      child.kill("SIGTERM");
      this.child = null;
      throw new Error("Failed to open stdio streams to the agent process.");
    }

    const processError = new Promise<never>((_, reject) => {
      child.once("error", (error: Error) => {
        if (this.child !== child) return;
        const code = (error as NodeJS.ErrnoException).code;
        const message =
          code === "ENOENT"
            ? `Could not find "${command}". Edit agents to correct the command or path, then press Restart.`
            : `Agent process error: ${error.message}`;
        this.cancelPendingPermissions();
        reject(new Error(message));
      });
    });
    processError.catch(() => {});

    stderr.setEncoding("utf8");
    stderr.on("data", (text: string) => {
      if (this.child !== child) return;
      this.lastStderr = `${this.lastStderr}${text}`.slice(-8_000);
      this.emit({ type: "stderr", text });
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.sessionId = null;
      this.connection = null;
      this.cancelPendingPermissions();
      this.cancelPendingAuth();
      this.onExit(code, signal);
      this.emit({ type: "exit", code, signal });
    });

    const toAgent = Writable.toWeb(stdin) as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(toAgent, fromAgent);
    const connection = new acp.ClientSideConnection(
      () => this.buildClient(),
      stream,
    );
    return { connection, processError };
  }

  private buildClient(): acp.Client {
    return {
      sessionUpdate: (params: acp.SessionNotification) =>
        this.handleSessionNotification(params),
      requestPermission: async (params: acp.RequestPermissionRequest) =>
        this.requestPermission(params),
      readTextFile: async (params: acp.ReadTextFileRequest) =>
        this.readTextFile(params),
      writeTextFile: async (params: acp.WriteTextFileRequest) => {
        await this.writeTextFile(params);
        return {};
      },
      createTerminal: () => this.rejectTerminal(),
      terminalOutput: () => this.rejectTerminal(),
      releaseTerminal: () => this.rejectTerminal(),
      waitForTerminalExit: () => this.rejectTerminal(),
      killTerminal: () => this.rejectTerminal(),
    };
  }

  private rejectTerminal(): never {
    throw rpcError("This client does not provide a terminal.", -32601);
  }

  private async handleSessionNotification(
    params: acp.SessionNotification,
  ): Promise<void> {
    const expectedId = this.pendingSessionId ?? this.sessionId;
    if (params.sessionId !== expectedId) return;
    const update = this.filterHostContextUpdate(params.update);
    if (!update) return;
    if (update.sessionUpdate === "config_option_update") {
      this.sessionConfigOptions.set(params.sessionId, update.configOptions);
    }
    if (update.sessionUpdate === "available_commands_update") {
      this.sessionCommands.set(params.sessionId, update.availableCommands);
    }
    this.emit({
      type: "update",
      sessionId: params.sessionId,
      update,
    });
  }

  private filterHostContextUpdate(
    update: acp.SessionUpdate,
  ): acp.SessionUpdate | null {
    if (
      update.sessionUpdate !== "user_message_chunk" ||
      update.content.type !== "text"
    ) {
      return update;
    }
    const text = update.content.text || "";
    const filtered = this.stripHostContext(text);
    if (filtered === text) return update;
    if (!filtered) return null;
    return {
      ...update,
      content: { ...update.content, text: filtered },
    };
  }

  private stripHostContext(text: string): string {
    const start = text.indexOf(HOST_CONTEXT_START);
    if (start === -1) return text;
    const end = text.indexOf(
      HOST_CONTEXT_END,
      start + HOST_CONTEXT_START.length,
    );
    if (end === -1) return text;
    const before = text.slice(0, start);
    const after = text.slice(end + HOST_CONTEXT_END.length);
    const stripped = `${before}${after}`;
    return before ? stripped : stripped.replace(/^\s+/, "");
  }

  private requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    this.assertSessionId(params.sessionId);
    return new Promise((resolve) => {
      const respond = (outcome: acp.RequestPermissionResponse) => {
        this.permissionResolvers.delete(respond);
        resolve(outcome);
      };
      this.permissionResolvers.add(respond);
      this.emit({ type: "permission", params, respond });
    });
  }

  private async readTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    this.assertSessionId(params.sessionId);
    await this.assertProjectPath(params.path, false);
    return this.editor.readTextFile(params.path, {
      line: params.line,
      limit: params.limit,
    });
  }

  private async writeTextFile(params: acp.WriteTextFileRequest): Promise<void> {
    this.assertSessionId(params.sessionId);
    await this.assertProjectPath(params.path, true);
    await this.editor.writeTextFile(params.path, params.content);
    await this.fileTreeManager.notifyPathModified(params.path);
    this.emit({ type: "file-written", path: params.path });
  }

  private assertSessionId(sessionId: acp.SessionId): void {
    if (this.sessionId === sessionId) return;
    throw rpcError(
      `Rejecting request for unknown ACP session: ${sessionId}`,
      -32002,
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

  private shouldSendHostContext(): boolean {
    return this.editor.getSendHostContext();
  }

  private hostContextMeta(): { [key: string]: unknown } | undefined {
    return this.shouldSendHostContext() ? HOST_CONTEXT_META : undefined;
  }

  private newSessionRequest(cwd: string): acp.NewSessionRequest {
    const request: acp.NewSessionRequest = { cwd, mcpServers: [] };
    const meta = this.hostContextMeta();
    if (meta) request._meta = meta;
    return request;
  }

  private loadSessionRequest(
    sessionId: acp.SessionId,
    cwd: string,
  ): acp.LoadSessionRequest {
    const request: acp.LoadSessionRequest = {
      sessionId,
      cwd,
      mcpServers: [],
    };
    const meta = this.hostContextMeta();
    if (meta) request._meta = meta;
    return request;
  }

  private appendHostContext(prompt: acp.ContentBlock[]): void {
    if (
      this.sessionId &&
      this.shouldSendHostContext() &&
      !this.hostContextSentSessionIds.has(this.sessionId)
    ) {
      prompt.push({ type: "text", text: HOST_CONTEXT_TEXT });
      this.hostContextSentSessionIds.add(this.sessionId);
    }
  }

  async prompt(prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    if (!this.connection || !this.sessionId) {
      throw new Error("Agent session is not ready.");
    }
    const blocks = [...prompt];
    this.appendHostContext(blocks);
    return this.connection.prompt({ sessionId: this.sessionId, prompt: blocks });
  }

  cancel(): void {
    if (this.connection && this.sessionId) {
      this.connection.cancel({ sessionId: this.sessionId }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({
          type: "error",
          message: `Failed to cancel agent turn: ${message}`,
        });
      });
    } else if (this.child) {
      this.teardownProcess();
    }
    this.cancelPendingPermissions();
    this.cancelPendingAuth();
  }

  private cancelPendingPermissions(): void {
    if (this.permissionResolvers.size === 0) return;
    for (const resolve of this.permissionResolvers) {
      resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionResolvers.clear();
    this.emit({ type: "permissions-cancelled" });
  }

  private cancelPendingAuth(): void {
    const resolve = this.authChoiceResolve;
    if (!resolve) return;
    this.authChoiceResolve = null;
    resolve({ type: "lifecycle" });
  }

  private async resolveAuthMethod(
    processError: Promise<never>,
  ): Promise<acp.AuthMethodAgent> {
    const classification = classifyAuthMethods(this.authMethods);
    if (classification.kind === "none") {
      throw new Error(
        "This agent requires authentication but offers no method this client can use. Sign in with the agent in a terminal, then press Restart.",
      );
    }
    if (classification.kind === "auto") {
      return classification.method;
    }
    const methods = classification.methods;
    const choice = await Promise.race([
      new Promise<AuthChoice>((resolve) => {
        this.authChoiceResolve = resolve;
        this.emit({
          type: "auth-required",
          methods,
          respond: (methodId) => {
            const settle = this.authChoiceResolve;
            if (!settle) return;
            this.authChoiceResolve = null;
            settle(
              methodId == null
                ? { type: "cancel" }
                : { type: "method", methodId },
            );
          },
        });
      }),
      processError,
    ]);
    if (choice.type === "lifecycle") throw new StartupCancelled();
    if (choice.type === "cancel") {
      throw new Error("Authentication cancelled. Press Restart to try again.");
    }
    const method = methods.find((m) => m.id === choice.methodId);
    if (!method) {
      throw new Error(
        "Selected an unknown authentication method. Press Restart to try again.",
      );
    }
    return method;
  }

  private async authenticateWithTimeout(
    connection: acp.ClientSideConnection,
    methodId: acp.AuthMethodId,
    processError: Promise<never>,
  ): Promise<void> {
    await this.withStartupTimeout(
      Promise.race([connection.authenticate({ methodId }), processError]),
      "authenticate",
    );
  }

  private newSessionWithTimeout(
    connection: acp.ClientSideConnection,
    cwd: string,
    processError: Promise<never>,
  ): Promise<acp.NewSessionResponse> {
    return this.withStartupTimeout(
      Promise.race([
        connection.newSession(this.newSessionRequest(cwd)),
        processError,
      ]),
      "session/new",
    );
  }

  private loginHint(method: acp.AuthMethod, error: unknown): string {
    const reason = error instanceof Error ? ` (${error.message})` : "";
    const command = terminalAuthCommand(method._meta?.["terminal-auth"]);
    if (command) {
      return `Sign-in required${reason}. Run \`${command}\` in a terminal, then press Restart.`;
    }
    return `Sign-in required${reason}. Sign in with the selected agent in a terminal, then press Restart.`;
  }

  private startupTimeoutError(step: string): Error {
    const target = this.target;
    const who = target ? `${target.name} (${target.kind})` : "agent";
    const stderr = this.lastStderr.trim();
    const hint = stderr ? `\n\nAgent stderr:\n${stderr}` : "";
    return new Error(
      `Timed out during ${step} for ${who} after ${
        STARTUP_TIMEOUT_MS / 1000
      }s.${hint}\nPress Restart and try again.`,
    );
  }

  private withStartupTimeout<T>(
    promise: Promise<T>,
    step: string,
  ): Promise<T> {
    const generation = this.startingPromise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.startingPromise === generation) this.teardownProcess();
        reject(this.startupTimeoutError(step));
      }, STARTUP_TIMEOUT_MS);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private teardownProcess(): void {
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {}
      this.child = null;
    }
    this.connection = null;
  }

  async newSession(cwd: string): Promise<acp.NewSessionResponse> {
    if (!this.connection) {
      throw new Error("Agent is not connected.");
    }
    const session = await this.connection.newSession(this.newSessionRequest(cwd));
    this.sessionId = session.sessionId;
    this.sessionCwd = cwd;
    this.loadedSessionIds.add(session.sessionId);
    if (session.configOptions) {
      this.sessionConfigOptions.set(session.sessionId, session.configOptions);
    }
    return session;
  }

  async loadSession(id: string, cwd: string): Promise<void> {
    if (!this.connection) {
      throw new Error("Agent is not connected.");
    }
    this.pendingSessionId = id;
    try {
      const loaded = await this.connection.loadSession(
        this.loadSessionRequest(id, cwd),
      );
      if (loaded?.configOptions) {
        this.sessionConfigOptions.set(id, loaded.configOptions);
      }
      this.sessionId = id;
      this.sessionCwd = cwd;
      this.loadedSessionIds.add(id);
    } finally {
      this.pendingSessionId = null;
    }
  }

  async deleteSession(
    id: string,
    cwd: string,
  ): Promise<{ deletedActive: boolean }> {
    if (!this.connection) {
      throw new Error("Agent is not connected.");
    }
    const deletedActive = id === this.sessionId;
    await this.connection.deleteSession({ sessionId: id });
    this.loadedSessionIds.delete(id);
    this.sessionConfigOptions.delete(id);
    this.sessionCommands.delete(id);
    if (deletedActive) {
      this.sessionId = null;
    }
    return { deletedActive };
  }

  async listSessions(cwd: string): Promise<acp.SessionInfo[]> {
    if (!this.connection || !this.canListSessions()) return [];
    const generation = ++this.sessionListGeneration;
    const roots = await this.editor.allowedRealRoots(cwd);
    const sessions: acp.SessionInfo[] = [];
    let cursor: string | null | undefined;
    const seenCursors = new Set<string>();

    do {
      const response = await this.connection.listSessions(
        cursor ? { cwd, cursor } : { cwd },
      );
      for (const session of response.sessions ?? []) {
        if (await this.sessionInfoAllowed(session, roots)) {
          sessions.push(session);
        }
      }
      const nextCursor = response.nextCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (true);

    if (generation !== this.sessionListGeneration) return [];
    return sessions;
  }

  private async sessionInfoAllowed(
    info: acp.SessionInfo,
    roots: string[],
  ): Promise<boolean> {
    return this.editor.isPathInRoots(info.cwd, roots);
  }

  dispose(): void {
    try {
      this.cancel();
    } catch {}
    if (this.child) {
      try {
        this.child.stdin?.end();
      } catch {}
    }
    this.teardownProcess();
    this.sessionId = null;
    this.sessionCwd = null;
    this.loadedSessionIds.clear();
    this.hostContextSentSessionIds.clear();
    this.sessionConfigOptions.clear();
    this.sessionCommands.clear();
  }
}
