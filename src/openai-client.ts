export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: ChatRole;
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
};

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: "auto" | "none";
};

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ChatToolCall[] }
  | { type: "done"; finishReason: string };

export type OpenAiResponseUsage = {
  requestBytes: number;
  responseBytes: number;
};

export type OpenAiClientOptions = {
  baseUrl: string;
  apiKey: string;
  // When true, POST with `stream: true` and parse SSE. The API does not have
  // to support this yet; keep false until it does. The event iterator is the
  // same either way so callers do not branch on transport.
  stream?: boolean;
  fetch?: typeof fetch;
};

export type OpenAiModelInfo = {
  id: string;
  description?: string;
};

export type FetchOpenAiModelsOptions = {
  baseUrl: string;
  apiKey: string;
  modelsUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

type ChatCompletionChoice = {
  finish_reason?: string | null;
  message?: {
    content?: string | null;
    tool_calls?: ChatToolCall[];
  };
  delta?: {
    content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: "function";
      function?: { name?: string; arguments?: string };
    }>;
  };
};

type ChatCompletionResponse = {
  choices?: ChatCompletionChoice[];
  error?: { message?: string };
};

type ModelsResponse = {
  data?: unknown;
  error?: { message?: string };
};

function boundFetch(
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  // Window.fetch must keep `this === window`. Storing `fetch` and calling it
  // later is an Illegal invocation in Pulsar's renderer.
  return globalThis.fetch(...args);
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function completionsUrl(baseUrl: string): string {
  return `${trimSlash(baseUrl)}/chat/completions`;
}

export class OpenAiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "OpenAiHttpError";
  }
}

export class OpenAiModelsError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: string,
  ) {
    super(message);
    this.name = "OpenAiModelsError";
  }
}

export class OpenAiChatClient {
  private readonly fetchImpl: typeof fetch;
  readonly stream: boolean;

  constructor(private readonly options: OpenAiClientOptions) {
    this.fetchImpl = options.fetch ?? boundFetch;
    this.stream = options.stream === true;
  }

  async *complete(
    request: ChatRequest,
    signal: AbortSignal,
    options: { onResponse?: (usage: OpenAiResponseUsage) => void } = {},
  ): AsyncIterable<ChatEvent> {
    if (this.stream) {
      yield* this.completeStream(request, signal, options);
      return;
    }
    yield* this.completeOnce(request, signal, options);
  }

  private async *completeOnce(
    request: ChatRequest,
    signal: AbortSignal,
    options: { onResponse?: (usage: OpenAiResponseUsage) => void },
  ): AsyncIterable<ChatEvent> {
    const { response, requestBytes } = await this.post(request, false, signal);
    const text = await response.text();
    options.onResponse?.({
      requestBytes,
      responseBytes: utf8ByteLength(text),
    });
    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new OpenAiHttpError(
        `API returned non-JSON (${response.status})`,
        response.status,
        text,
      );
    }
    if (!response.ok) {
      throw new OpenAiHttpError(
        parsed.error?.message || `API error ${response.status}`,
        response.status,
        text,
      );
    }
    const choice = parsed.choices?.[0];
    const message = choice?.message;
    if (message?.content) yield { type: "text", text: message.content };
    if (message?.tool_calls && message.tool_calls.length > 0) {
      yield { type: "tool_calls", calls: message.tool_calls };
    }
    yield { type: "done", finishReason: choice?.finish_reason || "stop" };
  }

  private async *completeStream(
    request: ChatRequest,
    signal: AbortSignal,
    options: { onResponse?: (usage: OpenAiResponseUsage) => void },
  ): AsyncIterable<ChatEvent> {
    const { response, requestBytes } = await this.post(request, true, signal);
    if (!response.ok) {
      const body = await response.text();
      options.onResponse?.({
        requestBytes,
        responseBytes: utf8ByteLength(body),
      });
      throw new OpenAiHttpError(
        `API error ${response.status}`,
        response.status,
        body,
      );
    }
    if (!response.body) {
      throw new Error("API stream response had no body.");
    }
    const pending = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finishReason = "stop";
    let receivedBytes = 0;
    for await (const payload of readSseData(response.body, signal, (bytes) => {
      receivedBytes += bytes;
    })) {
      if (payload === "[DONE]") break;
      let parsed: ChatCompletionResponse;
      try {
        parsed = JSON.parse(payload) as ChatCompletionResponse;
      } catch {
        continue;
      }
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) yield { type: "text", text: delta.content };
      for (const part of delta?.tool_calls ?? []) {
        const index = part.index ?? 0;
        const current = pending.get(index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.name += part.function.name;
        if (part.function?.arguments) current.arguments += part.function.arguments;
        pending.set(index, current);
      }
    }
    if (pending.size > 0) {
      const calls: ChatToolCall[] = [...pending.values()].map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
      yield { type: "tool_calls", calls };
    }
    options.onResponse?.({
      requestBytes,
      responseBytes: receivedBytes,
    });
    yield { type: "done", finishReason };
  }

  private async post(
    request: ChatRequest,
    stream: boolean,
    signal: AbortSignal,
  ): Promise<{ response: Response; requestBytes: number }> {
    const url = completionsUrl(this.options.baseUrl);
    const body = JSON.stringify({ ...request, stream });
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body,
      signal,
    });
    return { response, requestBytes: utf8ByteLength(body) };
  }
}

export async function fetchOpenAiModels(
  options: FetchOpenAiModelsOptions,
): Promise<OpenAiModelInfo[]> {
  const fetchImpl = options.fetch ?? boundFetch;
  const url = trimSlash(
    options.modelsUrl ?? `${trimSlash(options.baseUrl)}/models`,
  );
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
    },
    signal: options.signal,
  });
  const text = await response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OpenAiModelsError(
      `Model list returned non-JSON (${response.status})`,
      response.status,
      text,
    );
  }
  const object: ModelsResponse =
    parsed && typeof parsed === "object"
      ? (parsed as ModelsResponse)
      : {};
  if (!response.ok) {
    throw new OpenAiModelsError(
      object.error?.message || `Model list error ${response.status}`,
      response.status,
      text,
    );
  }

  const rawData = Array.isArray(object.data) ? object.data : [];
  const models: OpenAiModelInfo[] = [];
  for (const item of rawData) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const description =
      typeof item.description === "string" && item.description.trim() !== ""
        ? item.description.trim()
        : undefined;
    models.push(description ? { id, description } : { id });
  }
  if (models.length === 0) {
    throw new OpenAiModelsError("Model list is empty.", response.status, text);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onBytes?: (bytes: number) => void,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes?.(value.byteLength);
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let separator: number;
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

function sseData(block: string): string | null {
  const lines = block.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return data.join("\n");
}
