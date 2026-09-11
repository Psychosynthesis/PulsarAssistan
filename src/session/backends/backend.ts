import * as acp from "@agentclientprotocol/sdk";
import type { LaunchTarget } from "../types";
import type { StoredContextMessage } from "../../session-storage";

export interface BackendInitResult {
  sessionId: string;
  cwd: string;
  configOptions?: acp.SessionConfigOption[] | null;
}

export interface AgentBackend {
  readonly target: LaunchTarget;
  sessionId: string | null;
  sessionCwd: string | null;

  start(cwd: string): Promise<BackendInitResult>;
  prompt(prompt: acp.ContentBlock[]): Promise<acp.PromptResponse>;
  cancel(): void;

  newSession(cwd: string): Promise<acp.NewSessionResponse>;
  loadSession(id: string, cwd: string): Promise<void>;
  deleteSession(id: string, cwd: string): Promise<{ deletedActive: boolean }>;
  listSessions(cwd: string): Promise<acp.SessionInfo[]>;
  activateCachedSession(id: string): void;

  supportsImages(): boolean;
  supportsEmbeddedContext(): boolean;
  canListSessions(): boolean;
  canLoadSession(): boolean;
  canDeleteSession(): boolean;
  isSessionLoaded(id: string): boolean;

  currentSessionConfigOptions(): acp.SessionConfigOption[] | null;
  currentAvailableCommands(): acp.AvailableCommand[];
  setConfigOption(configId: string, value: string): Promise<void>;
  setModel(model: string): void;

  getSessionMessages?(): StoredContextMessage[];
  compactContext?(): Promise<{ compactedCount: number }>;

  dispose(): void;
}
