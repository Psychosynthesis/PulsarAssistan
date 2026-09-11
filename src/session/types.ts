import * as acp from "@agentclientprotocol/sdk";
import type { LaunchTarget } from "../agent-config";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "status-note"; text: string }
  | { type: "thought"; text: string }
  | {
      type: "initialized";
      info: acp.Implementation | null;
      capabilities: acp.AgentCapabilities | null;
      supportsImages: boolean;
    }
  | { type: "ready"; source: "start" | "new" | "load" }
  | { type: "session-list"; sessions: acp.SessionInfo[] }
  | { type: "turn-start" }
  | { type: "turn-end"; stopReason?: acp.StopReason }
  | { type: "update"; sessionId: acp.SessionId; update: acp.SessionUpdate }
  | { type: "permissions-cancelled" }
  | {
      type: "auth-required";
      methods: acp.AuthMethodAgent[];
      respond: (methodId: acp.AuthMethodId | null) => void;
    }
  | {
      type: "permission";
      params: acp.RequestPermissionRequest;
      respond: (outcome: acp.RequestPermissionResponse) => void;
    }
  | { type: "file-written"; path: string }
  | { type: "stderr"; text: string }
  | { type: "error"; message: string }
  | { type: "exit"; code: number | null; signal: string | null };

export type Listener = (event: AgentEvent) => void;

export class StartupCancelled extends Error {
  constructor() {
    super("Startup cancelled.");
    this.name = "StartupCancelled";
  }
}

export function isStartupCancellation(error: unknown): boolean {
  return error instanceof StartupCancelled;
}

export type AuthChoice =
  | { type: "method"; methodId: acp.AuthMethodId }
  | { type: "cancel" }
  | { type: "lifecycle" };

export type { LaunchTarget };
