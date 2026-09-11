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

// src/token-estimate.ts
var token_estimate_exports = {};
__export(token_estimate_exports, {
  DEFAULT_MODEL_CONTEXT_WINDOWS: () => DEFAULT_MODEL_CONTEXT_WINDOWS,
  FALLBACK_CONTEXT_WINDOW: () => FALLBACK_CONTEXT_WINDOW,
  estimateSessionTokens: () => estimateSessionTokens,
  estimateTokens: () => estimateTokens,
  resolveContextWindow: () => resolveContextWindow
});
module.exports = __toCommonJS(token_estimate_exports);
var DEFAULT_MODEL_CONTEXT_WINDOWS = {
  // Google Gemini
  gemini: 1e6,
  // Anthropic Claude
  claude: 2e5,
  // OpenAI newer flagships and reasoning models
  "gpt-4o": 128e3,
  "gpt-4o-mini": 128e3,
  "gpt-4-turbo": 128e3,
  "gpt-5": 128e3,
  o1: 128e3,
  "o1-mini": 128e3,
  "o1-preview": 128e3,
  o3: 128e3,
  "o3-mini": 128e3,
  o4: 128e3,
  // OpenAI legacy
  "gpt-4-32k": 32768,
  "gpt-4": 8192,
  "gpt-3.5-turbo-16k": 16384,
  "gpt-3.5": 16384,
  // DeepSeek
  deepseek: 128e3,
  // Qwen
  qwen: 128e3,
  // Meta LLaMA
  "llama-3.3": 128e3,
  "llama-3.2": 128e3,
  "llama-3.1": 128e3,
  "llama-3": 8192,
  // Mistral
  "mistral-large": 128e3,
  codestral: 128e3,
  mistral: 32768,
  // YandexGPT
  yandexgpt: 32768
};
var FALLBACK_CONTEXT_WINDOW = 128e3;
function estimateTokens(text) {
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
function estimateSessionTokens(messages, draftInput) {
  let total = 0;
  for (const msg of messages) {
    total += 4;
    if (msg.role) {
      total += 1;
    }
    if (msg.content) {
      total += estimateTokens(msg.content);
    }
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        total += 4;
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
function resolveContextWindow(modelId, customWindows, apiMetadata) {
  const normModel = (modelId || "").trim().toLowerCase();
  if (customWindows && typeof customWindows === "object") {
    for (const [key, val] of Object.entries(customWindows)) {
      if (typeof val === "number" && val > 0) {
        if (key.trim().toLowerCase() === normModel) {
          return val;
        }
      }
    }
    const sortedPrefixes = Object.entries(customWindows).filter(([k, v]) => typeof v === "number" && v > 0).sort((a, b) => b[0].length - a[0].length);
    for (const [prefix, val] of sortedPrefixes) {
      const normPrefix = prefix.trim().toLowerCase();
      if (normModel.startsWith(normPrefix) || normModel.includes(normPrefix)) {
        return val;
      }
    }
  }
  if (apiMetadata && typeof apiMetadata === "object") {
    const candidateKeys = [
      "context_length",
      "max_model_len",
      "max_context_length",
      "context_window",
      "max_tokens"
    ];
    for (const k of candidateKeys) {
      const val = apiMetadata[k];
      if (typeof val === "number" && val > 1024) {
        return val;
      }
    }
  }
  const sortedFamilies = Object.entries(DEFAULT_MODEL_CONTEXT_WINDOWS).sort(
    (a, b) => b[0].length - a[0].length
  );
  for (const [family, limit] of sortedFamilies) {
    if (normModel.includes(family)) {
      return limit;
    }
  }
  return FALLBACK_CONTEXT_WINDOW;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_MODEL_CONTEXT_WINDOWS,
  FALLBACK_CONTEXT_WINDOW,
  estimateSessionTokens,
  estimateTokens,
  resolveContextWindow
});
//# sourceMappingURL=token-estimate.js.map
