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

export type OpenAiClientOptions = {
  baseUrl: string;
  apiKey: string;
  // When true, POST with `stream: true` and parse SSE. The API does not have
  // to support this yet; keep false until it does. The event iterator is the
  // same either way so callers do not branch on transport.
  stream?: boolean;
  fetch?: typeof fetch;
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

export class OpenAiChatClient {
  private readonly fetchImpl: typeof fetch;
  readonly stream: boolean;

  constructor(private readonly options: OpenAiClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.stream = options.stream === true;
  }

  async *complete(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatEvent> {
    if (this.stream) {
      yield* this.completeStream(request, signal);
      return;
    }
    yield* this.completeOnce(request, signal);
  }

  private async *completeOnce(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatEvent> {
    const response = await this.post(request, false, signal);
    const text = await response.text();
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
  ): AsyncIterable<ChatEvent> {
    const response = await this.post(request, true, signal);
    if (!response.ok) {
      const body = await response.text();
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
    for await (const payload of readSseData(response.body, signal)) {
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
    yield { type: "done", finishReason };
  }

  private post(
    request: ChatRequest,
    stream: boolean,
    signal: AbortSignal,
  ): Promise<Response> {
    const url = completionsUrl(this.options.baseUrl);
    return this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({ ...request, stream }),
      signal,
    });
  }
}

async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
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
