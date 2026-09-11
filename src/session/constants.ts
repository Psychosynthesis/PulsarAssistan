import * as acp from "@agentclientprotocol/sdk";

declare const __PULSAR_ASSISTANT_VERSION__: string;

export const PROTOCOL_VERSION = acp.PROTOCOL_VERSION;
export const STARTUP_TIMEOUT_MS = 30_000;
export const AUTH_REQUIRED_CODE = -32000;

export const HOST_CONTEXT_START = "<pulsar-assistant-host-context>";
export const HOST_CONTEXT_END = "</pulsar-assistant-host-context>";

export const HOST_CONTEXT_MESSAGE = [
  "Host context: You are connected to the user through Pulsar Assistant,",
  "a Pulsar editor package using the Agent Client Protocol.",
  "The user sees this conversation in Pulsar, not in a standalone terminal.",
  "You can use ACP file and permission capabilities exposed by the client.",
  "This client does not provide a terminal. Do not expect to run shell commands through ACP.",
  "You cannot directly click, reload, or inspect Pulsar UI unless the user does it.",
  "Do not treat this host-context note as the user's request, and do not use it for session titles, summaries, or generated titles.",
].join(" ");

export const HOST_CONTEXT_TEXT = [
  HOST_CONTEXT_START,
  HOST_CONTEXT_MESSAGE,
  HOST_CONTEXT_END,
].join("\n");

export const CLIENT_INFO = {
  name: "pulsar-assistant",
  title: "Pulsar Assistant",
  version: typeof __PULSAR_ASSISTANT_VERSION__ !== "undefined"
    ? __PULSAR_ASSISTANT_VERSION__
    : "1.0.0",
};

export const HOST_CONTEXT_META = {
  "pulsar-assistant/host": {
    editor: "Pulsar",
    client: CLIENT_INFO.name,
    title: CLIENT_INFO.title,
    version: CLIENT_INFO.version,
  },
};
