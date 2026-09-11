import * as path from "path";
import { parseCommandLine } from "./util";

// Pure agent-registry logic. NO `atom` import so it can be unit-tested via the
// built lib/agent-config.js (like util.ts). All atom.config glue lives at the
// call sites and delegates here.

export type AgentType = "openai" | "acp";

export interface Agent {
  name: string;
  // Written to config: "openai" = HTTP API, "acp" = spawned CLI.
  // Legacy `type: "command"` is accepted and stored as "acp".
  type?: AgentType;
  command?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  defaultModel?: string;
  model?: string;
  getModelsUrl?: string;
  stream?: boolean;
}

export interface AgentsConfig {
  activeAgentId?: string;
  agents: Record<string, Agent>;
  [key: string]: unknown;
}

export type AcpLaunchTarget = {
  id: string;
  name: string;
  kind: "acp";
  command: string;
};

export type OpenaiLaunchTarget = {
  id: string;
  name: string;
  kind: "openai";
  baseUrl: string;
  apiKey: string;
  model: string;
  modelsUrl: string;
  stream: boolean;
};

export type LaunchTarget = AcpLaunchTarget | OpenaiLaunchTarget;

export type ResolveReason = "ok" | "no-agents" | "unset-or-invalid";

export const DEFAULT_AGENT_COMMAND = "copilot --acp --stdio";
export const COPILOT_AGENT_ID = "copilot";
export const COPILOT_AGENT_NAME = "GitHub Copilot";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (key) => key in b && deepEqual(a[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function hasOpenAiModel(entry: Record<string, unknown>): boolean {
  return !!(optionalString(entry.defaultModel) || optionalString(entry.model));
}

function agentType(entry: Record<string, unknown>): AgentType | null {
  if (entry.type === "openai") return "openai";
  if (entry.type === "acp" || entry.type === "command") return "acp";
  if (optionalString(entry.baseUrl) && hasOpenAiModel(entry)) return "openai";
  if (optionalString(entry.command)) return "acp";
  return null;
}

function isUsableAgent(entry: Record<string, unknown>): boolean {
  const type = agentType(entry);
  if (type === "openai") {
    return !!(optionalString(entry.baseUrl) && hasOpenAiModel(entry));
  }
  if (type === "acp") return !!optionalString(entry.command);
  return false;
}

// Lowercase, collapse non-alphanumerics to single dashes, trim dashes.
function sanitizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Choose a stable id/name when seeding from a legacy command string. The known
// Copilot default keeps its canonical identity; anything else derives from the
// executable basename so an arbitrary command is never mislabeled as Copilot.
function seedAgentFromCommand(command: string): { id: string; name: string } {
  if (command.trim() === DEFAULT_AGENT_COMMAND) {
    return { id: COPILOT_AGENT_ID, name: COPILOT_AGENT_NAME };
  }
  const argv = parseCommandLine(command);
  const exe = argv[0] ?? command;
  // path.win32 splits both `/` and `\` on every host (path.parse wouldn't).
  const base = path.win32.parse(exe).name || exe;
  const id = sanitizeId(base) || "agent";
  return { id, name: base || id };
}

function normalizeAgent(
  id: string,
  entry: Record<string, unknown>,
): Agent | null {
  if (!isUsableAgent(entry)) return null;
  const name =
    typeof entry.name === "string" && entry.name.trim() !== ""
      ? entry.name
      : id;
  const type = agentType(entry);
  if (!type) return null;
  const agent: Agent = { ...(entry as Record<string, unknown>), name, type };
  if (type === "acp" && agent.command) agent.command = agent.command.trim();
  if (type === "openai") {
    if (agent.baseUrl) agent.baseUrl = agent.baseUrl.trim().replace(/\/+$/, "");
    const defaultModel = optionalString(entry.defaultModel);
    if (defaultModel) agent.defaultModel = defaultModel;
    else delete agent.defaultModel;
    const model = optionalString(entry.model);
    if (model) agent.model = model;
    else delete agent.model;
    const getModelsUrl = optionalString(entry.getModelsUrl);
    if (getModelsUrl) agent.getModelsUrl = getModelsUrl;
    else delete agent.getModelsUrl;
  }
  return agent;
}

// Defensive coercion: tolerate undefined/non-object/garbage, drop invalid
// agent entries, and preserve unknown top-level and per-agent fields.
export function normalizeAgentsConfig(raw: unknown): AgentsConfig {
  const source = isObject(raw) ? raw : {};

  const agents: Record<string, Agent> = {};
  const rawAgents = isObject(source.agents) ? source.agents : {};
  for (const [id, entry] of Object.entries(rawAgents)) {
    if (!id || !isObject(entry)) continue;
    const agent = normalizeAgent(id, entry);
    if (!agent) continue;
    agents[id] = agent;
  }

  const config = { ...source, agents } as AgentsConfig;
  delete config.version;

  if (
    typeof source.activeAgentId === "string" &&
    source.activeAgentId.trim() !== ""
  ) {
    config.activeAgentId = source.activeAgentId;
  } else {
    delete config.activeAgentId;
  }

  return config;
}

// Seeds an empty registry and normalizes hand-written agent entries. The
// presence of an `agents` object is the migration marker: no agents object
// means a fresh config (seed from legacy command or the Copilot default), while
// an explicit empty object is respected as an intentional empty registry.
export function migrateAgentsConfig(
  raw: unknown,
  legacyCommand?: string,
): { config: AgentsConfig; changed: boolean } {
  const source = isObject(raw) ? raw : {};
  const hasAgents =
    Object.prototype.hasOwnProperty.call(source, "agents") &&
    isObject(source.agents);
  const normalized = normalizeAgentsConfig(raw);

  if (hasAgents) {
    const ids = Object.keys(normalized.agents);
    if (
      ids.length > 0 &&
      (!normalized.activeAgentId || !normalized.agents[normalized.activeAgentId])
    ) {
      normalized.activeAgentId = ids[0];
    }
    return {
      config: normalized,
      changed: !deepEqual(source, normalized),
    };
  }

  const command =
    typeof legacyCommand === "string" && legacyCommand.trim() !== ""
      ? legacyCommand.trim()
      : DEFAULT_AGENT_COMMAND;
  const seed = seedAgentFromCommand(command);
  normalized.agents = { [seed.id]: { name: seed.name, type: "acp", command } };
  normalized.activeAgentId = seed.id;
  return { config: normalized, changed: true };
}

// STRICT launch resolution. `preferredId` is panel-local (serialized with the
// dock item). Global `activeAgentId` is only the default for a newly opened
// panel — never a map of project paths.
export function resolveAgent(
  config: AgentsConfig,
  preferredId?: string | null,
): {
  agent?: Agent;
  id?: string;
  reason: ResolveReason;
} {
  if (Object.keys(config.agents).length === 0) {
    return { reason: "no-agents" };
  }
  if (preferredId && config.agents[preferredId]) {
    return { agent: config.agents[preferredId], id: preferredId, reason: "ok" };
  }
  const id = config.activeAgentId;
  if (id && config.agents[id]) {
    return { agent: config.agents[id], id, reason: "ok" };
  }
  return { reason: "unset-or-invalid" };
}

export function resolveActiveAgent(config: AgentsConfig): {
  agent?: Agent;
  id?: string;
  reason: ResolveReason;
} {
  return resolveAgent(config);
}

export function resolveApiKey(
  agent: Agent,
  env: NodeJS.Dict<string> = process.env,
): string | null {
  const direct = optionalString(agent.apiKey);
  if (direct) return direct;
  const envName = optionalString(agent.apiKeyEnv);
  if (!envName) return null;
  return optionalString(env[envName]) ?? null;
}

export function toLaunchTarget(
  id: string,
  agent: Agent,
  env: NodeJS.Dict<string> = process.env,
  model?: string,
): LaunchTarget {
  const type = agent.type ?? (agent.command ? "acp" : "openai");
  if (type === "openai") {
    const baseUrl = optionalString(agent.baseUrl)?.replace(/\/+$/, "");
    const configuredModel =
      optionalString(agent.defaultModel) ?? optionalString(agent.model);
    const effectiveModel = optionalString(model) ?? configuredModel;
    if (!baseUrl || !effectiveModel) {
      throw new Error(
        `API "${agent.name}" is missing baseUrl or defaultModel. Edit the agent config.`,
      );
    }
    const apiKey = resolveApiKey(agent, env);
    if (!apiKey) {
      throw new Error(
        `API "${agent.name}" has no API key. Set apiKey or apiKeyEnv.`,
      );
    }
    return {
      id,
      name: agent.name,
      kind: "openai",
      baseUrl,
      apiKey,
      model: effectiveModel,
      modelsUrl: optionalString(agent.getModelsUrl) ?? `${baseUrl}/models`,
      stream: agent.stream === true,
    };
  }
  const command = optionalString(agent.command);
  if (!command) {
    throw new Error(
      `Agent "${agent.name}" has no command. Edit the agent config.`,
    );
  }
  return { id, name: agent.name, kind: "acp", command };
}

export function groupAgents(
  agents: Record<string, Agent>,
): Array<{ type: AgentType; entries: Array<[string, Agent]> }> {
  const openai: Array<[string, Agent]> = [];
  const acp: Array<[string, Agent]> = [];
  for (const entry of Object.entries(agents)) {
    if (entry[1].type === "openai") openai.push(entry);
    else acp.push(entry);
  }
  const groups: Array<{ type: AgentType; entries: Array<[string, Agent]> }> = [];
  if (openai.length > 0) groups.push({ type: "openai", entries: openai });
  if (acp.length > 0) groups.push({ type: "acp", entries: acp });
  return groups;
}

export function launchTargetsEqual(
  a: LaunchTarget | null | undefined,
  b: LaunchTarget | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.id !== b.id || a.kind !== b.kind) return false;
  if (a.kind === "acp" && b.kind === "acp") {
    return a.command === b.command;
  }
  if (a.kind === "openai" && b.kind === "openai") {
    return (
      a.baseUrl === b.baseUrl &&
      a.model === b.model &&
      a.apiKey === b.apiKey &&
      a.stream === b.stream
    );
  }
  return false;
}

// True when the running agent's id is no longer present in the registry.
export function isLaunchedAgentStale(
  config: AgentsConfig,
  launchedSnapshotId: string | null | undefined,
): boolean {
  if (!launchedSnapshotId) return false;
  return !config.agents[launchedSnapshotId];
}
