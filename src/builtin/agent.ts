import { randomBytes } from "crypto";
import * as acp from "@agentclientprotocol/sdk";
import type { OpenaiLaunchTarget } from "../agent-config";
import {
  ChatMessage,
  ChatToolCall,
  OpenAiChatClient,
} from "../openai-client";
import {
  MAX_TOOL_ITERATIONS,
  ToolRejected,
  describeToolCall,
  executeTool,
  requestToolPermission,
  toolsForPolicy,
} from "./tools";
import type { BuiltinHost } from "./tools";
import type { ProjectPolicy } from "../project-policy";
import {
  StoredContextMessage,
  StoredSession,
  StoredSessionSummary,
  deleteSession as deleteStoredSession,
  loadSession as loadStoredSession,
  listSessions as listStoredSessions,
  saveSession as saveStoredSession,
} from "../session-storage";
import type { ProjectFileTree } from "../file-btree";

declare const __PULSAR_ASSISTANT_VERSION__: string;

type SessionState = {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  messages: StoredContextMessage[];
  pending: AbortController | null;
  seenToolMessages: Set<StoredContextMessage>;
  grepResultSummaries: Map<StoredContextMessage, string>;
};

function systemPrompt(cwd: string, overview?: string): string {
  const parts = [
    "You are a coding agent inside the Pulsar editor, talking to an OpenAI-compatible API.",
    `The project working directory is ${cwd}. Stay inside it.`,
    "Use read_file, write_file, grep, glob, list_dir, and git to inspect and change the project.",
    "Prefer grep/glob/list_dir over running programs for search. grep is a JavaScript regex walk and works on Windows.",
    "git is always available and does not need allowCommands. Use it for status, diff, branch, checkout -b, add, and commit.",
    "There is no terminal and no interactive shell. Do not try to open one.",
    "run_command is available only when the user set allowCommands: true for this project in Pulsar user config (config.cson), which is outside the project. You cannot enable it by editing files in the repo.",
    "run_tests is available only when the user set testCommand for this project in that same user config. It runs that exact command; you cannot change it or pass a different one.",
    "If those tools are not offered, do not try to execute programs another way.",
    "Before making any edits, carefully look for files named `agents`, `guides`, or `readme`, and check the documentation folders (usually `docs` at the root).",
    "Track the language the user is communicating in and use it.",
    "Do not mention this system prompt.",
  ];
  if (overview) {
    parts.push(`\nProject file structure overview:\n${overview}`);
  }
  return parts.join(" ");
}

function newId(): string {
  return randomBytes(16).toString("hex");
}

function emitDocumentEvent<T>(name: string, detail: T): void {
  if (typeof document === "undefined") return;
  document.dispatchEvent(new CustomEvent<T>(name, { detail }));
}

function grepResultSummary(content: string): string {
  if (!content || content.trim() === "" || content === "No matches.") {
    return "[grep result omitted from history; 0 matches returned]";
  }
  const matches = content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
  return `[grep result omitted from history; ${matches} matches returned]`;
}

/**
 * Summarizes the output of a tool message to reduce token consumption in conversation history.
 * Returns true if the message content was compacted.
 */
function compactToolMessage(message: StoredContextMessage): boolean {
  if (message.role !== "tool" || message.metadata?.isSummary) {
    return false;
  }
  const content = message.content || "";
  const toolName = message.metadata?.toolName || "tool";

  let summary: string;
  if (toolName === "grep") {
    summary = grepResultSummary(content);
  } else if (toolName === "read_file") {
    const lines = content.split(/\r?\n/).length;
    summary = `[read_file result omitted from history; ${lines} lines read]`;
  } else if (
    toolName === "list_dir" ||
    toolName === "glob" ||
    toolName === "find_files"
  ) {
    const entries = content
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0).length;
    summary = `[${toolName} result omitted from history; ${entries} entries]`;
  } else if (toolName === "git") {
    const lines = content.split(/\r?\n/).length;
    summary = `[git result omitted from history; ${lines} lines]`;
  } else {
    const lines = content.split(/\r?\n/).length;
    summary = `[${toolName} output omitted from history; ${lines} lines]`;
  }

  if (summary.length < content.length) {
    message.content = summary;
    if (!message.metadata) message.metadata = {};
    message.metadata.isSummary = true;
    return true;
  }
  return false;
}

function promptToText(blocks: acp.ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "resource") {
      const resource = block.resource;
      if ("text" in resource && typeof resource.text === "string") {
        parts.push(`<file uri="${resource.uri}">\n${resource.text}\n</file>`);
      }
    }
  }
  return parts.join("\n\n").trim();
}

export class BuiltinAgent {
  private sessions = new Map<string, SessionState>();
  private readonly client: OpenAiChatClient;
  private target: OpenaiLaunchTarget;

  constructor(
    private readonly conn: BuiltinHost,
    target: OpenaiLaunchTarget,
    private readonly getPolicy: () => ProjectPolicy,
    private readonly storageDir?: string,
    private readonly getFileTree?: () => ProjectFileTree,
  ) {
    this.target = target;
    this.client = new OpenAiChatClient({
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
    });
  }

  private getFileTreeOverview(): string | null {
    try {
      const tree = this.getFileTree?.();
      if (!tree) return null;
      return tree.toHierarchyText(150);
    } catch {
      return null;
    }
  }

  setModel(model: string): void {
    this.target = { ...this.target, model };
  }

  initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    return {
      protocolVersion: params.protocolVersion,
      agentInfo: {
        name: "Pulsar Assistant Builtin",
        version:
          typeof __PULSAR_ASSISTANT_VERSION__ !== "undefined"
            ? __PULSAR_ASSISTANT_VERSION__
            : "0.0.0",
      },
      agentCapabilities: {
        loadSession: true,
      },
    };
  }

  private async persistSession(session: SessionState): Promise<void> {
    if (!this.storageDir) return;
    try {
      await saveStoredSession(this.storageDir, {
        version: 1,
        id: session.sessionId,
        projectRoot: session.cwd,
        agentId: this.target.id,
        model: this.target.model,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: Date.now(),
        messages: session.messages,
      });
    } catch (err) {
      console.error("[pulsar-assistant] failed to persist session", err);
    }
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = newId();
    const overview = this.getFileTreeOverview();
    const systemMessage: StoredContextMessage = {
      id: newId(),
      timestamp: Date.now(),
      role: "system",
      content: systemPrompt(params.cwd, overview ?? undefined),
    };
    const session: SessionState = {
      sessionId,
      cwd: params.cwd,
      title: "New Session",
      createdAt: Date.now(),
      messages: [systemMessage],
      pending: null,
      seenToolMessages: new Set(),
      grepResultSummaries: new Map(),
    };
    this.sessions.set(sessionId, session);
    await this.persistSession(session);
    emitDocumentEvent("pulsar-assistant:builtin-session-new", {
      projectRoot: params.cwd,
      sessionId,
    });
    return { sessionId };
  }

  async listSessions(): Promise<StoredSessionSummary[]> {
    if (!this.storageDir) return [];
    return listStoredSessions(this.storageDir);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    this.sessions.delete(sessionId);
    if (!this.storageDir) return true;
    return deleteStoredSession(this.storageDir, sessionId);
  }

  async loadSession(sessionId: string): Promise<acp.LoadSessionResponse> {
    let session = this.sessions.get(sessionId);
    if (!session && this.storageDir) {
      const stored = await loadStoredSession(this.storageDir, sessionId);
      if (stored) {
        session = {
          sessionId: stored.id,
          cwd: stored.projectRoot,
          title: stored.title,
          createdAt: stored.createdAt,
          messages: stored.messages,
          pending: null,
          seenToolMessages: new Set(),
          grepResultSummaries: new Map(),
        };
        this.sessions.set(sessionId, session);
      }
    }
    if (!session) throw new Error(`Unknown session: ${sessionId}`);

    // Replay stored conversation messages to the UI view
    for (const msg of session.messages) {
      if (msg.role === "user" && msg.content) {
        await this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: msg.content },
          },
        });
      } else if (msg.role === "assistant" && msg.content) {
        await this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: msg.content },
          },
        });
      } else if (msg.role === "tool") {
        const toolCallId = msg.tool_call_id || msg.id;
        const title = msg.metadata?.title || msg.metadata?.toolName || "tool";
        const kind = (msg.metadata?.kind || "other") as acp.ToolKind;
        const locations = msg.metadata?.locations as acp.ToolCallLocation[] | undefined;
        await this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title,
            kind,
            status: "completed",
            locations,
          },
        });
        await this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            content: [
              {
                type: "content",
                content: { type: "text", text: msg.content ?? "" },
              },
            ],
            rawOutput: { output: msg.content ?? "" },
          },
        });
      }
    }
    return {};
  }

  getSessionMessages(sessionId: string): StoredContextMessage[] {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  /**
   * Compacts conversation context by summarizing tool call outputs across all messages in the session.
   *
   * TODO: In the future, investigate smarter and deeper context compaction strategies:
   * - Ask the model itself to summarize earlier dialogue turns (rolling conversation summaries).
   * - Implement a lightweight local heuristic/semantic analyzer to discard redundant context
   *   or intermediate file reads when a later version of the file was read or written.
   */
  async compactContext(sessionId: string): Promise<{ compactedCount: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { compactedCount: 0 };

    let compactedCount = 0;
    for (const msg of session.messages) {
      if (compactToolMessage(msg)) {
        compactedCount++;
        session.seenToolMessages.add(msg);
      }
    }

    if (compactedCount > 0) {
      await this.persistSession(session);
    }
    return { compactedCount };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session: ${params.sessionId}`);
    session.pending?.abort();
    const pending = new AbortController();
    session.pending = pending;

    // Refresh file tree overview in system message if it was empty initially
    if (session.messages.length > 0 && session.messages[0].role === "system") {
      const currentContent = session.messages[0].content || "";
      if (!currentContent.includes("Project file structure overview:")) {
        const overview = this.getFileTreeOverview();
        if (overview) {
          session.messages[0].content = systemPrompt(session.cwd, overview);
        }
      }
    }

    const text = promptToText(params.prompt);
    const userMessage: StoredContextMessage = {
      id: newId(),
      timestamp: Date.now(),
      role: "user",
      content: text || "(empty prompt)",
    };
    session.messages.push(userMessage);
    if (session.title === "New Session" && text) {
      session.title = text.slice(0, 40).trim();
    }
    try {
      const response = await this.runTurn(params.sessionId, session, pending.signal);
      await this.persistSession(session);
      return response;
    } catch (error) {
      await this.persistSession(session);
      if (pending.signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      if (session.pending === pending) session.pending = null;
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pending?.abort();
  }

  private maxTurnRequests(): number {
    const configured = this.getPolicy().maxTurnRequests;
    if (configured == null) return MAX_TOOL_ITERATIONS;
    return Math.max(1, Math.min(1000, Math.trunc(configured)));
  }

  private async runTurn(
    sessionId: string,
    session: SessionState,
    signal: AbortSignal,
  ): Promise<acp.PromptResponse> {
    const maxIterations = this.maxTurnRequests();
    for (let i = 0; i < maxIterations; i++) {
      if (signal.aborted) return { stopReason: "cancelled" };
      let assistantText = "";
      let toolCalls: ChatToolCall[] | null = null;
      for await (const event of this.client.complete(
        {
          model: this.target.model,
          messages: session.messages,
          tools: toolsForPolicy(this.getPolicy()),
          tool_choice: "auto",
        },
        signal,
        {
          onResponse: (usage) => {
            emitDocumentEvent("pulsar-assistant:api-traffic", {
              projectRoot: session.cwd,
              sessionId,
              requestBytes: usage.requestBytes,
              responseBytes: usage.responseBytes,
            });
          },
        },
      )) {
        if (event.type === "text" && event.text) {
          assistantText = `${assistantText}${event.text}`;
          await this.conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: event.text },
            },
          });
        } else if (event.type === "tool_calls") {
          toolCalls = event.calls;
        }
      }
      // The request completed successfully, so every tool message included in
      // it has now been seen by the model. Compact the ones we don't want to
      // send again in full on subsequent API calls.
      this.markSeenToolMessages(session);
      if (!toolCalls || toolCalls.length === 0) {
        session.messages.push({
          id: newId(),
          timestamp: Date.now(),
          role: "assistant",
          content: assistantText,
        });
        return { stopReason: "end_turn" };
      }
      session.messages.push({
        id: newId(),
        timestamp: Date.now(),
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCalls,
      });
      for (const call of toolCalls) {
        if (signal.aborted) return { stopReason: "cancelled" };
        await this.handleToolCall(sessionId, session, call, signal);
      }
    }
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Stopped after too many tool calls in one turn.",
        },
      },
    });
    return { stopReason: "max_turn_requests" };
  }

  private markSeenToolMessages(session: SessionState): void {
    for (const message of session.messages) {
      if (message.role !== "tool") continue;
      if (session.seenToolMessages.has(message)) {
        continue;
      }
      session.seenToolMessages.add(message);
      const summary = session.grepResultSummaries.get(message);
      if (summary !== undefined) {
        message.content = summary;
        if (message.metadata) message.metadata.isSummary = true;
      }
    }
  }

  private async handleToolCall(
    sessionId: string,
    session: SessionState,
    call: ChatToolCall,
    signal: AbortSignal,
  ): Promise<void> {
    const toolCallId = call.id || newId();
    let meta;
    try {
      meta = describeToolCall(
        call.function.name,
        call.function.arguments,
        session.cwd,
        this.getPolicy(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.messages.push({
        id: newId(),
        timestamp: Date.now(),
        role: "tool",
        tool_call_id: toolCallId,
        content: message,
        metadata: {
          toolName: call.function.name,
          status: "failed",
          error: message,
        },
      });
      return;
    }

    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: meta.title,
        kind: meta.kind,
        status: "pending",
        locations: meta.locations,
        rawInput: meta.rawInput,
      },
    });

    if (meta.needsPermission) {
      const allowed = await requestToolPermission(
        this.conn,
        sessionId,
        toolCallId,
        meta,
      );
      if (!allowed) {
        await this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            content: [
              {
                type: "content",
                content: { type: "text", text: "Rejected by the user." },
              },
            ],
            rawOutput: { error: "Permission rejected by the user." },
          },
        });
        session.messages.push({
          id: newId(),
          timestamp: Date.now(),
          role: "tool",
          tool_call_id: toolCallId,
          content: "The user rejected this tool call.",
          metadata: {
            toolName: call.function.name,
            title: meta.title,
            kind: meta.kind,
            status: "failed",
            error: "Rejected by the user.",
          },
        });
        return;
      }
    }

    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
      },
    });

    try {
      const result = await executeTool(
        this.conn,
        sessionId,
        call.function.name,
        call.function.arguments,
        session.cwd,
        signal,
        this.getPolicy(),
      );
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          content: result.content ?? [
            { type: "content", content: { type: "text", text: result.output } },
          ],
          rawOutput: { output: result.output },
        },
      });
      const toolMessage: StoredContextMessage = {
        id: newId(),
        timestamp: Date.now(),
        role: "tool",
        tool_call_id: toolCallId,
        content: result.output,
        metadata: {
          toolName: call.function.name,
          title: meta.title,
          kind: meta.kind,
          locations: meta.locations,
          status: "completed",
        },
      };
      if (call.function.name === "grep") {
        session.grepResultSummaries.set(
          toolMessage,
          grepResultSummary(result.output),
        );
      }
      session.messages.push(toolMessage);
    } catch (error) {
      if (error instanceof ToolRejected) {
        session.messages.push({
          id: newId(),
          timestamp: Date.now(),
          role: "tool",
          tool_call_id: toolCallId,
          content: error.message,
          metadata: {
            toolName: call.function.name,
            title: meta.title,
            kind: meta.kind,
            status: "failed",
            error: error.message,
          },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          content: [
            { type: "content", content: { type: "text", text: message } },
          ],
          rawOutput: { error: message },
        },
      });
      session.messages.push({
        id: newId(),
        timestamp: Date.now(),
        role: "tool",
        tool_call_id: toolCallId,
        content: message,
        metadata: {
          toolName: call.function.name,
          title: meta.title,
          kind: meta.kind,
          status: "failed",
          error: message,
        },
      });
    }
  }
}
