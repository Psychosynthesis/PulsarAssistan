import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  safeProjectKey,
  getProjectStorageDir,
  getProjectTreePath,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  deleteMessage,
  clearSessionMessages,
} from "../lib/session-storage.js";

test("safeProjectKey: produces deterministic safe string", () => {
  const p1 = "C:\\My Projects\\test-project";
  const p2 = "/home/user/code/my-project";

  const k1 = safeProjectKey(p1);
  const k2 = safeProjectKey(p2);

  assert.match(k1, /^[a-zA-Z0-9._-]+$/);
  assert.match(k2, /^[a-zA-Z0-9._-]+$/);
  assert.equal(safeProjectKey(p1), k1);
});

test("getProjectStorageDir: nests under configDir/storage/pulsar-assistant", () => {
  const configDir = "/home/user/.pulsar";
  const projectRoot = "/home/user/project";
  const dir = getProjectStorageDir(configDir, projectRoot);
  assert.ok(dir.startsWith(path.join(configDir, "storage", "pulsar-assistant", "projects")));
  assert.equal(getProjectTreePath(dir), path.join(dir, "tree.json"));
});

test("session CRUD and message operations", async (t) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pulsar-storage-test-"));
  t.after(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  const session1 = {
    version: 1,
    id: "sess-1234",
    projectRoot: "/fake/root",
    agentId: "openai",
    model: "gpt-4o",
    title: "Test Session",
    createdAt: 1000,
    updatedAt: 1000,
    messages: [
      {
        id: "msg-1",
        timestamp: 1001,
        role: "system",
        content: "You are an assistant.",
      },
      {
        id: "msg-2",
        timestamp: 1002,
        role: "user",
        content: "Hello!",
      },
      {
        id: "msg-3",
        timestamp: 1003,
        role: "tool",
        tool_call_id: "call-1",
        content: "file contents",
        metadata: {
          toolName: "read_file",
          status: "completed",
        },
      },
    ],
  };

  // 1. Save
  await saveSession(tmpDir, session1);

  // 2. Load
  const loaded = await loadSession(tmpDir, "sess-1234");
  assert.ok(loaded);
  assert.equal(loaded.id, "sess-1234");
  assert.equal(loaded.messages.length, 3);
  assert.equal(loaded.messages[2].metadata?.toolName, "read_file");

  // 3. List
  const list = await listSessions(tmpDir);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "sess-1234");
  assert.equal(list[0].messageCount, 3);

  // 4. Delete single message
  const deletedMsg = await deleteMessage(tmpDir, "sess-1234", "msg-2");
  assert.equal(deletedMsg, true);
  const reloadedAfterMsgDelete = await loadSession(tmpDir, "sess-1234");
  assert.equal(reloadedAfterMsgDelete.messages.length, 2);
  assert.ok(!reloadedAfterMsgDelete.messages.some((m) => m.id === "msg-2"));

  // 5. Clear messages (leaves system)
  await clearSessionMessages(tmpDir, "sess-1234");
  const reloadedAfterClear = await loadSession(tmpDir, "sess-1234");
  assert.equal(reloadedAfterClear.messages.length, 1);
  assert.equal(reloadedAfterClear.messages[0].role, "system");

  // 6. Delete session
  const deletedSess = await deleteSession(tmpDir, "sess-1234");
  assert.equal(deletedSess, true);
  const reloadedAfterDelete = await loadSession(tmpDir, "sess-1234");
  assert.equal(reloadedAfterDelete, null);
});
