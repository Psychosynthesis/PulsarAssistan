import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateSessionTokens,
  resolveContextWindow,
  DEFAULT_MODEL_CONTEXT_WINDOWS,
  FALLBACK_CONTEXT_WINDOW,
} from "../lib/token-estimate.js";

test("estimateTokens: handles empty string", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test("estimateTokens: ASCII and code character ratio (~3.7 chars / token)", () => {
  const code = "function testMethod() { return true; }"; // 39 chars
  const tokens = estimateTokens(code);
  assert.ok(tokens >= 10 && tokens <= 13, `tokens=${tokens}`);
});

test("estimateTokens: Cyrillic and Unicode character ratio (~1.5 chars / token)", () => {
  const text = "Привет мир, это тестовое сообщение на русском языке."; // 52 chars
  const tokens = estimateTokens(text);
  assert.ok(tokens >= 30 && tokens <= 40, `tokens=${tokens}`);
});

test("estimateTokens: mixed code and text", () => {
  const mixed = "const x = 'Привет'; // 5 букв";
  const tokens = estimateTokens(mixed);
  assert.ok(tokens > 0);
});

test("estimateSessionTokens: calculates messages and tool calls with overhead", () => {
  const messages = [
    {
      id: "1",
      timestamp: 1000,
      role: "system",
      content: "You are a helpful assistant.",
    },
    {
      id: "2",
      timestamp: 2000,
      role: "user",
      content: "Hello, can you read file.txt?",
    },
    {
      id: "3",
      timestamp: 3000,
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "file.txt" }),
          },
        },
      ],
    },
    {
      id: "4",
      timestamp: 4000,
      role: "tool",
      tool_call_id: "call_1",
      content: "line 1\nline 2\nline 3\n",
    },
  ];

  const totalTokens = estimateSessionTokens(messages);
  assert.ok(totalTokens > 30 && totalTokens < 70, `totalTokens=${totalTokens}`);

  const withDraft = estimateSessionTokens(messages, "Drafting next question...");
  assert.ok(withDraft > totalTokens, "Draft input should increase token estimate");
});

test("resolveContextWindow: resolves custom overrides from config", () => {
  const custom = {
    "my-custom-model": 64_000,
    "prefix-model": 256_000,
  };

  // Exact match
  assert.equal(resolveContextWindow("my-custom-model", custom), 64_000);
  // Case insensitivity
  assert.equal(resolveContextWindow("MY-CUSTOM-MODEL", custom), 64_000);
  // Prefix match
  assert.equal(resolveContextWindow("prefix-model-v2", custom), 256_000);
});

test("resolveContextWindow: resolves API metadata", () => {
  assert.equal(
    resolveContextWindow("unknown-api-model", undefined, { context_length: 65_536 }),
    65_536,
  );
  assert.equal(
    resolveContextWindow("unknown-api-model-2", undefined, { max_model_len: 32_768 }),
    32_768,
  );
});

test("resolveContextWindow: resolves known model families", () => {
  assert.equal(resolveContextWindow("gemini-1.5-pro"), 1_000_000);
  assert.equal(resolveContextWindow("claude-3-5-sonnet-20241022"), 200_000);
  assert.equal(resolveContextWindow("gpt-4o"), 128_000);
  assert.equal(resolveContextWindow("gpt-4o-mini"), 128_000);
  assert.equal(resolveContextWindow("o1-preview"), 128_000);
  assert.equal(resolveContextWindow("o3-mini"), 128_000);
  assert.equal(resolveContextWindow("deepseek-chat"), 128_000);
  assert.equal(resolveContextWindow("qwen-2.5-72b"), 128_000);
  assert.equal(resolveContextWindow("gpt-4-32k"), 32_768);
  assert.equal(resolveContextWindow("gpt-4"), 8_192);
  assert.equal(resolveContextWindow("gpt-3.5-turbo"), 16_384);
});

test("resolveContextWindow: falls back to 128k for completely unknown models", () => {
  assert.equal(resolveContextWindow("some-mysterious-model"), FALLBACK_CONTEXT_WINDOW);
});
