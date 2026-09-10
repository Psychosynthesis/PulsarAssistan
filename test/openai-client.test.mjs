import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAiChatClient, fetchOpenAiModels } from "../lib/openai-client.js";

test("OpenAiChatClient: non-stream complete yields text then done", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "hello" },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const client = new OpenAiChatClient({
    baseUrl: "https://api.example/v1",
    apiKey: "k",
    stream: false,
    fetch: fetchImpl,
  });
  const events = [];
  for await (const event of client.complete(
    { model: "dev", messages: [{ role: "user", content: "hi" }] },
    new AbortController().signal,
  )) {
    events.push(event);
  }
  assert.deepEqual(events, [
    { type: "text", text: "hello" },
    { type: "done", finishReason: "stop" },
  ]);
});

test("OpenAiChatClient: non-stream complete yields tool_calls", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.stream, false);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "1",
                  type: "function",
                  function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
  const client = new OpenAiChatClient({
    baseUrl: "https://api.example/v1",
    apiKey: "k",
    fetch: fetchImpl,
  });
  const events = [];
  for await (const event of client.complete(
    { model: "dev", messages: [] },
    new AbortController().signal,
  )) {
    events.push(event);
  }
  assert.equal(events[0].type, "tool_calls");
  assert.equal(events[1].type, "done");
});

test("OpenAiChatClient: stream path parses SSE deltas", async () => {
  const sse = [
    "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
    "data: [DONE]\n\n",
  ].join("");
  const fetchImpl = async () =>
    new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  const client = new OpenAiChatClient({
    baseUrl: "https://api.example/v1",
    apiKey: "k",
    stream: true,
    fetch: fetchImpl,
  });
  const events = [];
  for await (const event of client.complete(
    { model: "dev", messages: [{ role: "user", content: "hi" }] },
    new AbortController().signal,
  )) {
    events.push(event);
  }
  assert.deepEqual(events, [
    { type: "text", text: "Hel" },
    { type: "text", text: "lo" },
    { type: "done", finishReason: "stop" },
  ]);
});

test("OpenAiChatClient: stream path accepts CRLF SSE", async () => {
  const sse =
    "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\r\n\r\n" +
    "data: [DONE]\r\n\r\n";
  const client = new OpenAiChatClient({
    baseUrl: "https://api.example/v1",
    apiKey: "k",
    stream: true,
    fetch: async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
  const events = [];
  for await (const event of client.complete(
    { model: "dev", messages: [] },
    new AbortController().signal,
  )) {
    events.push(event);
  }
  assert.deepEqual(events, [
    { type: "text", text: "Hi" },
    { type: "done", finishReason: "stop" },
  ]);
});

test("fetchOpenAiModels: uses the default /models endpoint", async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, "https://api.example/v1/models");
    assert.equal(init.headers.authorization, "Bearer k");
    return new Response(
      JSON.stringify({
        data: [
          { id: "b", description: "Second" },
          { id: "a" },
        ],
      }),
      { status: 200 },
    );
  };
  const models = await fetchOpenAiModels({
    baseUrl: "https://api.example/v1",
    apiKey: "k",
    fetch: fetchImpl,
  });
  assert.deepEqual(models, [
    { id: "a" },
    { id: "b", description: "Second" },
  ]);
});

test("fetchOpenAiModels: honors a custom modelsUrl", async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, "https://example.com/custom/models");
    return new Response(JSON.stringify({ data: [{ id: "x" }] }), {
      status: 200,
    });
  };
  const models = await fetchOpenAiModels({
    baseUrl: "https://api.example/v1",
    apiKey: "k",
    modelsUrl: "https://example.com/custom/models",
    fetch: fetchImpl,
  });
  assert.deepEqual(models, [{ id: "x" }]);
});

test("fetchOpenAiModels: throws when the list is empty", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200 });
  await assert.rejects(
    fetchOpenAiModels({
      baseUrl: "https://api.example/v1",
      apiKey: "k",
      fetch: fetchImpl,
    }),
    /Model list is empty/,
  );
});
