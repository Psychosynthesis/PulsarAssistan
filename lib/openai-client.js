"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/openai-client.ts
var openai_client_exports = {};
__export(openai_client_exports, {
  OpenAiChatClient: () => OpenAiChatClient,
  OpenAiHttpError: () => OpenAiHttpError,
  OpenAiModelsError: () => OpenAiModelsError,
  fetchOpenAiModels: () => fetchOpenAiModels,
  formatApiErrorMessage: () => formatApiErrorMessage
});
module.exports = __toCommonJS(openai_client_exports);
function boundFetch(...args) {
  return globalThis.fetch(...args);
}
function utf8ByteLength(text) {
  return new TextEncoder().encode(text).length;
}
function trimSlash(url) {
  return url.replace(/\/+$/, "");
}
function completionsUrl(baseUrl) {
  return `${trimSlash(baseUrl)}/chat/completions`;
}
function formatApiErrorMessage(status, rawBody) {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return `API error ${status}`;
  }
  try {
    const json = JSON.parse(trimmed);
    let detail = "";
    if (typeof json.error === "string") {
      detail = json.error;
    } else if (json.error && typeof json.error === "object" && typeof json.error.message === "string") {
      detail = json.error.message;
    } else if (typeof json.message === "string") {
      detail = json.message;
    } else if (typeof json.detail === "string") {
      detail = json.detail;
    }
    if (detail) {
      const cleaned = detail.replace(/\s+/g, " ").trim();
      return `API error ${status}: ${cleaned.length > 250 ? cleaned.slice(0, 247) + "\u2026" : cleaned}`;
    }
  } catch {
  }
  const stripped = trimmed.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (stripped) {
    const short = stripped.length > 200 ? stripped.slice(0, 197) + "\u2026" : stripped;
    return `API error ${status}: ${short}`;
  }
  return `API error ${status}`;
}
var OpenAiHttpError = class extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "OpenAiHttpError";
  }
};
var OpenAiModelsError = class extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "OpenAiModelsError";
  }
};
var OpenAiChatClient = class {
  constructor(options) {
    this.options = options;
    this.fetchImpl = options.fetch ?? boundFetch;
  }
  async *complete(request, signal, options = {}) {
    if (this.options.stream) {
      yield* this.completeStream(request, signal, options);
    } else {
      yield* this.completeOnce(request, signal, options);
    }
  }
  async *completeOnce(request, signal, options) {
    const { response, requestBytes } = await this.post(request, false, signal);
    const text = await response.text();
    options.onResponse?.({
      requestBytes,
      responseBytes: utf8ByteLength(text)
    });
    if (!response.ok) {
      throw new OpenAiHttpError(
        formatApiErrorMessage(response.status, text),
        response.status,
        text
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OpenAiHttpError(
        `API returned non-JSON (${response.status})`,
        response.status,
        text
      );
    }
    const choice = parsed.choices?.[0];
    const message = choice?.message;
    const reasoning = message?.reasoning_content || message?.thought || message?.thinking || message?.reasoning;
    if (reasoning) {
      yield { type: "thought", text: reasoning };
    }
    if (message?.content) yield { type: "text", text: message.content };
    if (message?.tool_calls && message.tool_calls.length > 0) {
      yield { type: "tool_calls", calls: message.tool_calls };
    }
    yield { type: "done", finishReason: choice?.finish_reason || "stop" };
  }
  async *completeStream(request, signal, options) {
    const { response, requestBytes } = await this.post(request, true, signal);
    if (!response.ok) {
      const body = await response.text();
      options.onResponse?.({
        requestBytes,
        responseBytes: utf8ByteLength(body)
      });
      throw new OpenAiHttpError(
        formatApiErrorMessage(response.status, body),
        response.status,
        body
      );
    }
    if (!response.body) {
      throw new Error("API stream response had no body.");
    }
    const pending = /* @__PURE__ */ new Map();
    let finishReason = "stop";
    let receivedBytes = 0;
    for await (const payload of readSseData(response.body, signal, (bytes) => {
      receivedBytes += bytes;
    })) {
      if (payload === "[DONE]") break;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      const thoughtDelta = delta?.reasoning_content || delta?.thought || delta?.thinking || delta?.reasoning;
      if (thoughtDelta) {
        yield { type: "thought", text: thoughtDelta };
      }
      if (delta?.content) yield { type: "text", text: delta.content };
      for (const part of delta?.tool_calls ?? []) {
        const index = part.index ?? 0;
        const current = pending.get(index) ?? {
          id: "",
          name: "",
          arguments: ""
        };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.name += part.function.name;
        if (part.function?.arguments) current.arguments += part.function.arguments;
        pending.set(index, current);
      }
    }
    if (pending.size > 0) {
      const calls = [...pending.values()].map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments }
      }));
      yield { type: "tool_calls", calls };
    }
    options.onResponse?.({
      requestBytes,
      responseBytes: receivedBytes
    });
    yield { type: "done", finishReason };
  }
  async post(request, stream, signal) {
    const url = completionsUrl(this.options.baseUrl);
    const body = JSON.stringify({ ...request, stream });
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`
      },
      body,
      signal
    });
    return { response, requestBytes: utf8ByteLength(body) };
  }
};
async function fetchOpenAiModels(options) {
  const fetchImpl = options.fetch ?? boundFetch;
  const url = trimSlash(
    options.modelsUrl ?? `${trimSlash(options.baseUrl)}/models`
  );
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${options.apiKey}`
    },
    signal: options.signal
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OpenAiModelsError(
      `Model list returned non-JSON (${response.status})`,
      response.status,
      text
    );
  }
  const object = parsed && typeof parsed === "object" ? parsed : {};
  if (!response.ok) {
    throw new OpenAiModelsError(
      object.error?.message || `Model list error ${response.status}`,
      response.status,
      text
    );
  }
  const rawData = Array.isArray(object.data) ? object.data : [];
  const models = [];
  for (const item of rawData) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const description = typeof item.description === "string" && item.description.trim() !== "" ? item.description.trim() : void 0;
    models.push(description ? { id, description } : { id });
  }
  if (models.length === 0) {
    throw new OpenAiModelsError("Model list is empty.", response.status, text);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}
async function* readSseData(body, signal, onBytes) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes?.(value.byteLength);
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let separator;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = sseData(raw);
        if (data !== null) yield data;
      }
    }
    const trailing = sseData(buffer);
    if (trailing !== null) yield trailing;
  } finally {
    reader.releaseLock();
  }
}
function sseData(block) {
  const lines = block.split(/\r?\n/);
  const data = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return data.join("\n");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  OpenAiChatClient,
  OpenAiHttpError,
  OpenAiModelsError,
  fetchOpenAiModels,
  formatApiErrorMessage
});
//# sourceMappingURL=openai-client.js.map
