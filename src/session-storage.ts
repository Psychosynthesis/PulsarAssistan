import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ChatToolCall } from "./openai-client";

export interface StoredToolCallMetadata {
  toolName?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path: string; line?: number | null }>;
  status?: "completed" | "failed" | "pending";
  error?: string;
  isSummary?: boolean;
  [key: string]: unknown;
}

export interface StoredContextMessage {
  id: string;
  timestamp: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  metadata?: StoredToolCallMetadata;
}

export interface StoredSession {
  version: 1;
  id: string;
  projectRoot: string;
  agentId: string;
  model: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredContextMessage[];
}

export interface StoredSessionSummary {
  id: string;
  title: string;
  projectRoot: string;
  agentId: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export function safeProjectKey(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const baseName =
    path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, "_") || "root";
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${baseName}-${hash}`;
}

export function getProjectStorageDir(
  configDirPath: string,
  projectRoot: string,
): string {
  return path.join(
    configDirPath,
    "storage",
    "pulsar-assistant",
    "projects",
    safeProjectKey(projectRoot),
  );
}

export function getSessionsDir(projectStorageDir: string): string {
  return path.join(projectStorageDir, "sessions");
}

export function getProjectTreePath(projectStorageDir: string): string {
  return path.join(projectStorageDir, "tree.json");
}

function safeSessionFileName(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Invalid sessionId: ${sessionId}`);
  }
  return `${sessionId}.json`;
}

export function sessionFilePath(
  projectStorageDir: string,
  sessionId: string,
): string {
  return path.join(getSessionsDir(projectStorageDir), safeSessionFileName(sessionId));
}

async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.promises.writeFile(tempPath, data, "utf8");
  try {
    await fs.promises.rename(tempPath, filePath);
  } catch (err) {
    // Fallback if cross-device or Windows rename lock issue occurs
    try {
      await fs.promises.unlink(filePath);
      await fs.promises.rename(tempPath, filePath);
    } catch {
      await fs.promises.unlink(tempPath).catch(() => {});
      throw err;
    }
  }
}

export async function saveSession(
  projectStorageDir: string,
  session: StoredSession,
): Promise<void> {
  const target = sessionFilePath(projectStorageDir, session.id);
  session.updatedAt = Date.now();
  const json = JSON.stringify(session, null, 2);
  await atomicWriteFile(target, json);
}

export async function loadSession(
  projectStorageDir: string,
  sessionId: string,
): Promise<StoredSession | null> {
  let target: string;
  try {
    target = sessionFilePath(projectStorageDir, sessionId);
  } catch {
    return null;
  }
  try {
    const raw = await fs.promises.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.messages)) {
      return parsed;
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function listSessions(
  projectStorageDir: string,
): Promise<StoredSessionSummary[]> {
  const sessionsDir = getSessionsDir(projectStorageDir);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(sessionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const summaries: StoredSessionSummary[] = [];
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
          messageCount: session.messages.length,
        });
      }
    } catch {
      // Ignore corrupted session files in the listing
    }
  }

  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

export async function deleteSession(
  projectStorageDir: string,
  sessionId: string,
): Promise<boolean> {
  let target: string;
  try {
    target = sessionFilePath(projectStorageDir, sessionId);
  } catch {
    return false;
  }
  try {
    await fs.promises.unlink(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function deleteMessage(
  projectStorageDir: string,
  sessionId: string,
  messageId: string,
): Promise<boolean> {
  const session = await loadSession(projectStorageDir, sessionId);
  if (!session) return false;
  const initialLength = session.messages.length;
  session.messages = session.messages.filter((m) => m.id !== messageId);
  if (session.messages.length === initialLength) return false;
  await saveSession(projectStorageDir, session);
  return true;
}

export async function clearSessionMessages(
  projectStorageDir: string,
  sessionId: string,
): Promise<boolean> {
  const session = await loadSession(projectStorageDir, sessionId);
  if (!session) return false;
  session.messages = session.messages.filter((m) => m.role === "system");
  await saveSession(projectStorageDir, session);
  return true;
}
