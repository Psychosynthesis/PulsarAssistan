import { test } from "node:test";
import assert from "node:assert/strict";
// Imports the built bundle, not src/agent-config.ts: tests run on Pulsar's Node
// (20.16, per .nvmrc), which can't execute TypeScript. `npm run build` emits
// lib/agent-config.js.
import {
  COPILOT_AGENT_ID,
  COPILOT_AGENT_NAME,
  DEFAULT_AGENT_COMMAND,
  groupAgents,
  isLaunchedAgentStale,
  launchTargetsEqual,
  migrateAgentsConfig,
  normalizeAgentsConfig,
  resolveAgent,
  resolveActiveAgent,
  resolveApiKey,
  toLaunchTarget,
} from "../lib/agent-config.js";

// ---------------------------------------------------------------------------
// normalizeAgentsConfig
// ---------------------------------------------------------------------------

test("normalizeAgentsConfig: tolerates undefined and non-objects", () => {
  for (const raw of [undefined, null, 42, "x", []]) {
    const config = normalizeAgentsConfig(raw);
    assert.deepEqual(config.agents, {});
    assert.equal(config.version, undefined);
    assert.equal(config.activeAgentId, undefined);
  }
});

test("normalizeAgentsConfig: drops invalid agent entries", () => {
  const config = normalizeAgentsConfig({
    agents: {
      good: { name: "Good", command: "good --acp" },
      noCommand: { name: "No command" },
      emptyCommand: { name: "Empty", command: "   " },
      notObject: "nope",
    },
  });
  assert.deepEqual(Object.keys(config.agents), ["good"]);
  assert.deepEqual(config.agents.good, {
    name: "Good",
    type: "acp",
    command: "good --acp",
  });
});

test("normalizeAgentsConfig: defaults a missing name to the id", () => {
  const config = normalizeAgentsConfig({
    agents: { foo: { command: "foo --acp" } },
  });
  assert.equal(config.agents.foo.name, "foo");
});

test("normalizeAgentsConfig: preserves unknown fields but drops legacy version", () => {
  const config = normalizeAgentsConfig({
    version: 1,
    future: "keep-me",
    agents: { foo: { name: "Foo", command: "foo", env: { A: "1" } } },
  });
  assert.equal(config.future, "keep-me");
  assert.equal(config.version, undefined);
  assert.deepEqual(config.agents.foo.env, { A: "1" });
});

test("normalizeAgentsConfig: drops an empty activeAgentId", () => {
  assert.equal(normalizeAgentsConfig({ activeAgentId: "  " }).activeAgentId, undefined);
});

// ---------------------------------------------------------------------------
// migrateAgentsConfig (seeding)
// ---------------------------------------------------------------------------

test("migrateAgentsConfig: seeds the copilot default when unmigrated and empty", () => {
  const { config, changed } = migrateAgentsConfig(undefined);
  assert.equal(changed, true);
  assert.equal(config.activeAgentId, COPILOT_AGENT_ID);
  assert.deepEqual(config.agents[COPILOT_AGENT_ID], {
    name: COPILOT_AGENT_NAME,
    type: "acp",
    command: DEFAULT_AGENT_COMMAND,
  });
});

test("migrateAgentsConfig: legacy copilot command keeps the canonical identity", () => {
  const { config } = migrateAgentsConfig(undefined, DEFAULT_AGENT_COMMAND);
  assert.deepEqual(Object.keys(config.agents), [COPILOT_AGENT_ID]);
  assert.equal(config.agents[COPILOT_AGENT_ID].name, COPILOT_AGENT_NAME);
});

test("migrateAgentsConfig: derives id/name from an arbitrary legacy command", () => {
  const { config } = migrateAgentsConfig(undefined, "gemini --experimental-acp");
  assert.deepEqual(Object.keys(config.agents), ["gemini"]);
  assert.equal(config.agents.gemini.name, "gemini");
  assert.equal(config.agents.gemini.command, "gemini --experimental-acp");
  assert.equal(config.activeAgentId, "gemini");
});

test("migrateAgentsConfig: derives id/name from a quoted path command", () => {
  const { config } = migrateAgentsConfig(undefined, '"C:\\tools\\my agent.cmd" --acp');
  const ids = Object.keys(config.agents);
  assert.equal(ids.length, 1);
  assert.equal(config.agents[ids[0]].name, "my agent");
  assert.equal(ids[0], "my-agent");
});

test("migrateAgentsConfig: precedence — existing agents beat legacy and default", () => {
  const { config } = migrateAgentsConfig(
    { agents: { custom: { name: "Custom", command: "custom --acp" } } },
    "gemini --experimental-acp",
  );
  assert.deepEqual(Object.keys(config.agents), ["custom"]);
  assert.equal(config.activeAgentId, "custom");
});

test("migrateAgentsConfig: preserves a valid existing activeAgentId", () => {
  const { config } = migrateAgentsConfig({
    activeAgentId: "b",
    agents: {
      a: { name: "A", command: "a" },
      b: { name: "B", command: "b" },
    },
  });
  assert.equal(config.activeAgentId, "b");
});

// ---------------------------------------------------------------------------
// migrateAgentsConfig (idempotency / configured registry)
// ---------------------------------------------------------------------------

test("migrateAgentsConfig: is idempotent once seeded", () => {
  const first = migrateAgentsConfig(undefined).config;
  const second = migrateAgentsConfig(first);
  assert.equal(second.changed, false);
  assert.deepEqual(second.config, first);
});

test("migrateAgentsConfig: respects an intentionally empty configured registry", () => {
  const { config, changed } = migrateAgentsConfig({ agents: {} });
  assert.equal(changed, false);
  assert.deepEqual(config.agents, {});
  assert.equal(config.activeAgentId, undefined);
});

test("migrateAgentsConfig: auto-corrects a missing or invalid activeAgentId", () => {
  const { config, changed } = migrateAgentsConfig({
    activeAgentId: "gone",
    agents: { a: { name: "A", type: "acp", command: "a" } },
  });
  assert.equal(changed, true);
  assert.equal(config.activeAgentId, "a");
});

test("migrateAgentsConfig: stamps type on configured agents that omit it", () => {
  const { config, changed } = migrateAgentsConfig({
    activeAgentId: "a",
    agents: { a: { name: "A", command: "a" } },
  });
  assert.equal(changed, true);
  assert.equal(config.agents.a.type, "acp");
  assert.equal(config.activeAgentId, "a");
});

test("migrateAgentsConfig: drops a legacy version field", () => {
  const { config, changed } = migrateAgentsConfig({
    version: 99,
    activeAgentId: "a",
    agents: { a: { name: "A", command: "a" }, bad: { name: "Bad" } },
  });
  assert.equal(changed, true);
  assert.equal(config.version, undefined);
  assert.deepEqual(Object.keys(config.agents), ["a"]);
});

// ---------------------------------------------------------------------------
// resolveActiveAgent (STRICT)
// ---------------------------------------------------------------------------

test("resolveActiveAgent: ok when activeAgentId is set and present", () => {
  const config = normalizeAgentsConfig({
    activeAgentId: "a",
    agents: { a: { name: "A", command: "a" } },
  });
  const resolved = resolveActiveAgent(config);
  assert.equal(resolved.reason, "ok");
  assert.equal(resolved.id, "a");
  assert.equal(resolved.agent.command, "a");
});

test("resolveActiveAgent: no-agents when registry is empty", () => {
  assert.equal(resolveActiveAgent(normalizeAgentsConfig({})).reason, "no-agents");
});

test("resolveActiveAgent: STRICT — never falls back to the first agent", () => {
  const config = normalizeAgentsConfig({
    agents: {
      a: { name: "A", command: "a" },
      b: { name: "B", command: "b" },
    },
  });
  const resolved = resolveActiveAgent(config);
  assert.equal(resolved.reason, "unset-or-invalid");
  assert.equal(resolved.agent, undefined);
  assert.equal(resolved.id, undefined);
});

test("resolveActiveAgent: unset-or-invalid when activeAgentId points nowhere", () => {
  const config = normalizeAgentsConfig({
    activeAgentId: "gone",
    agents: { a: { name: "A", command: "a" } },
  });
  assert.equal(resolveActiveAgent(config).reason, "unset-or-invalid");
});

// ---------------------------------------------------------------------------
// isLaunchedAgentStale
// ---------------------------------------------------------------------------

test("isLaunchedAgentStale: true when the launched id is gone", () => {
  const config = normalizeAgentsConfig({ agents: { a: { name: "A", command: "a" } } });
  assert.equal(isLaunchedAgentStale(config, "b"), true);
});

test("isLaunchedAgentStale: false when the launched id is still present", () => {
  const config = normalizeAgentsConfig({ agents: { a: { name: "A", command: "a" } } });
  assert.equal(isLaunchedAgentStale(config, "a"), false);
});

test("isLaunchedAgentStale: false when no agent is launched", () => {
  const config = normalizeAgentsConfig({ agents: {} });
  assert.equal(isLaunchedAgentStale(config, null), false);
  assert.equal(isLaunchedAgentStale(config, undefined), false);
});

test("normalizeAgentsConfig: keeps an OpenAI-compatible API without a command", () => {
  const config = normalizeAgentsConfig({
    agents: {
      ours: {
        name: "Ours",
        type: "openai",
        baseUrl: "https://api.example/v1/",
        model: "dev",
        apiKeyEnv: "OURS_KEY",
      },
    },
  });
  assert.equal(config.agents.ours.type, "openai");
  assert.equal(config.agents.ours.baseUrl, "https://api.example/v1");
  assert.equal(config.agents.ours.model, "dev");
  assert.equal(config.agents.ours.command, undefined);
});

test("normalizeAgentsConfig: drops openai entries missing model or baseUrl", () => {
  const config = normalizeAgentsConfig({
    agents: {
      noModel: { type: "openai", baseUrl: "https://api.example/v1" },
      noUrl: { type: "openai", model: "dev" },
    },
  });
  assert.deepEqual(config.agents, {});
});

test("resolveAgent: prefers the panel-local id over the global default", () => {
  const config = normalizeAgentsConfig({
    activeAgentId: "a",
    agents: {
      a: { name: "A", command: "a" },
      b: { name: "B", command: "b" },
    },
  });
  const resolved = resolveAgent(config, "b");
  assert.equal(resolved.id, "b");
  assert.equal(resolved.reason, "ok");
});

test("resolveAgent: falls back to the global default when the panel id is gone", () => {
  const config = normalizeAgentsConfig({
    activeAgentId: "a",
    agents: { a: { name: "A", command: "a" } },
  });
  assert.equal(resolveAgent(config, "gone").id, "a");
});

test("toLaunchTarget: openai reads the API key from env", () => {
  const config = normalizeAgentsConfig({
    agents: {
      ours: {
        name: "Ours",
        type: "openai",
        baseUrl: "https://api.example/v1",
        model: "dev",
        apiKeyEnv: "OURS_KEY",
      },
    },
  });
  const target = toLaunchTarget("ours", config.agents.ours, { OURS_KEY: "secret" });
  assert.equal(target.kind, "openai");
  if (target.kind === "openai") {
    assert.equal(target.apiKey, "secret");
    assert.equal(target.stream, false);
  }
});

test("toLaunchTarget: command fallback keeps the spawn command", () => {
  const target = toLaunchTarget("copilot", {
    name: "GitHub Copilot",
    command: "copilot --acp --stdio",
  });
  assert.equal(target.kind, "acp");
  if (target.kind === "acp") {
    assert.equal(target.command, DEFAULT_AGENT_COMMAND);
  }
});

test("normalizeAgentsConfig: maps type command to acp", () => {
  const config = normalizeAgentsConfig({
    agents: { old: { name: "Old", type: "command", command: "old --acp" } },
  });
  assert.equal(config.agents.old.type, "acp");
});

test("groupAgents: API group then ACP, preserving key order", () => {
  const config = normalizeAgentsConfig({
    agents: {
      copilot: { name: "GitHub Copilot", command: "copilot --acp --stdio" },
      ours: {
        name: "Ours",
        type: "openai",
        baseUrl: "https://api.example/v1",
        model: "dev",
        apiKey: "k",
      },
      vibe: { name: "Vibe", type: "acp", command: "vibe --acp" },
    },
  });
  const groups = groupAgents(config.agents);
  assert.deepEqual(
    groups.map((group) => [group.type, group.entries.map(([id]) => id)]),
    [
      ["openai", ["ours"]],
      ["acp", ["copilot", "vibe"]],
    ],
  );
});

test("resolveApiKey: direct apiKey wins over env", () => {
  assert.equal(
    resolveApiKey({ name: "x", apiKey: "direct", apiKeyEnv: "E" }, { E: "env" }),
    "direct",
  );
});

test("launchTargetsEqual: openai identity includes model and key", () => {
  const a = toLaunchTarget(
    "ours",
    { name: "Ours", type: "openai", baseUrl: "https://x", model: "m", apiKey: "k" },
  );
  const b = toLaunchTarget(
    "ours",
    { name: "Ours", type: "openai", baseUrl: "https://x", model: "m", apiKey: "k" },
  );
  const c = toLaunchTarget(
    "ours",
    { name: "Ours", type: "openai", baseUrl: "https://x", model: "m", apiKey: "other" },
  );
  assert.equal(launchTargetsEqual(a, b), true);
  assert.equal(launchTargetsEqual(a, c), false);
});

test("toLaunchTarget: openai defaults model to defaultModel over legacy model", () => {
  const target = toLaunchTarget(
    "ours",
    {
      name: "Ours",
      type: "openai",
      baseUrl: "https://api.example/v1/",
      defaultModel: "prod",
      model: "legacy",
      apiKey: "k",
    },
    {},
  );
  assert.equal(target.kind, "openai");
  if (target.kind === "openai") {
    assert.equal(target.model, "prod");
    assert.equal(target.modelsUrl, "https://api.example/v1/models");
  }
});

test("toLaunchTarget: openai accepts an explicit panel model", () => {
  const target = toLaunchTarget(
    "ours",
    {
      name: "Ours",
      type: "openai",
      baseUrl: "https://api.example/v1",
      defaultModel: "prod",
      apiKey: "k",
    },
    {},
    "chosen",
  );
  assert.equal(target.kind, "openai");
  if (target.kind === "openai") {
    assert.equal(target.model, "chosen");
  }
});

test("toLaunchTarget: openai honors a custom modelsUrl", () => {
  const target = toLaunchTarget(
    "ours",
    {
      name: "Ours",
      type: "openai",
      baseUrl: "https://api.example/v1",
      defaultModel: "prod",
      apiKey: "k",
      modelsUrl: "https://example.com/custom/models",
    },
    {},
  );
  assert.equal(target.kind, "openai");
  if (target.kind === "openai") {
    assert.equal(target.modelsUrl, "https://example.com/custom/models");
  }
});
