import type { StoredContextMessage } from "./session-storage";

/**
 * Built-in context window sizes for well-known model families.
 */
export const DEFAULT_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Google Gemini
  gemini: 1_000_000,

  // Anthropic Claude
  claude: 200_000,

  // OpenAI newer flagships and reasoning models
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-5": 128_000,
  o1: 128_000,
  "o1-mini": 128_000,
  "o1-preview": 128_000,
  o3: 128_000,
  "o3-mini": 128_000,
  o4: 128_000,

  // OpenAI legacy
  "gpt-4-32k": 32_768,
  "gpt-4": 8_192,
  "gpt-3.5-turbo-16k": 16_384,
  "gpt-3.5": 16_384,

  // DeepSeek
  deepseek: 128_000,

  // Qwen
  qwen: 128_000,

  // Meta LLaMA
  "llama-3.3": 128_000,
  "llama-3.2": 128_000,
  "llama-3.1": 128_000,
  "llama-3": 8_192,

  // Mistral
  "mistral-large": 128_000,
  codestral: 128_000,
  mistral: 32_768,

  // YandexGPT
  yandexgpt: 32_768,
};

export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Fast weighted character-level token count estimation without external dependencies.
 * - ASCII characters (Latin, digits, punctuation, whitespace, code): ~3.7 chars / token.
 * - Non-ASCII characters (Cyrillic, CJK, multibyte Unicode): ~1.5 chars / token.
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }
  return Math.ceil(asciiCount / 3.7 + nonAsciiCount / 1.5);
}

/**
 * Estimates total tokens consumed by all messages in a session plus optional draft input.
 * Includes chat format overhead (~4 tokens per message).
 */
export function estimateSessionTokens(
  messages: StoredContextMessage[],
  draftInput?: string,
): number {
  let total = 0;
  for (const msg of messages) {
    total += 4; // per-message envelope overhead
    if (msg.role) {
      total += 1;
    }
    if (msg.content) {
      total += estimateTokens(msg.content);
    }
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        total += 4; // tool call envelope
        if (call.function?.name) {
          total += estimateTokens(call.function.name);
        }
        if (call.function?.arguments) {
          total += estimateTokens(call.function.arguments);
        }
      }
    }
  }

  if (draftInput && draftInput.trim().length > 0) {
    total += 4 + estimateTokens(draftInput);
  }

  return total;
}

/**
 * Resolves context window size for a given model:
 * 1. User overrides from `modelContextWindows` config (exact or prefix match).
 * 2. API metadata from /models (context_length, max_model_len, etc.).
 * 3. Default known model families.
 * 4. Fallback (128k).
 */
export function resolveContextWindow(
  modelId: string,
  customWindows?: Record<string, number>,
  apiMetadata?: Record<string, unknown>,
): number {
  const normModel = (modelId || "").trim().toLowerCase();

  // 1. User custom overrides (exact match or longest prefix match)
  if (customWindows && typeof customWindows === "object") {
    // Check exact match first
    for (const [key, val] of Object.entries(customWindows)) {
      if (typeof val === "number" && val > 0) {
        if (key.trim().toLowerCase() === normModel) {
          return val;
        }
      }
    }
    // Check prefix match (sorted by key length descending)
    const sortedPrefixes = Object.entries(customWindows)
      .filter(([k, v]) => typeof v === "number" && v > 0)
      .sort((a, b) => b[0].length - a[0].length);

    for (const [prefix, val] of sortedPrefixes) {
      const normPrefix = prefix.trim().toLowerCase();
      if (normModel.startsWith(normPrefix) || normModel.includes(normPrefix)) {
        return val;
      }
    }
  }

  // 2. API metadata inspection
  if (apiMetadata && typeof apiMetadata === "object") {
    const candidateKeys = [
      "context_length",
      "max_model_len",
      "max_context_length",
      "context_window",
      "max_tokens",
    ];
    for (const k of candidateKeys) {
      const val = apiMetadata[k];
      if (typeof val === "number" && val > 1024) {
        return val;
      }
    }
  }

  // 3. Known model family matching (sorted by key length descending to prefer e.g. gpt-4-32k over gpt-4)
  const sortedFamilies = Object.entries(DEFAULT_MODEL_CONTEXT_WINDOWS).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [family, limit] of sortedFamilies) {
    if (normModel.includes(family)) {
      return limit;
    }
  }

  // 4. Default fallback
  return FALLBACK_CONTEXT_WINDOW;
}
