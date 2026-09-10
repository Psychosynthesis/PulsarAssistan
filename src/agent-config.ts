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
  model?: string;
  stream?: boolean;
}

export interface AgentsConfig {
  version: number;
  activeAgentId?: string;
  agents: Record<string, Agent>;
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
  stream: boolean;
};

export type LaunchTarget = AcpLaunchTarget | OpenaiLaunchTarget;

export type ResolveReason = "ok" | "no-agents" | "unset-or-invalid";

export const AGENTS_CONFIG_VERSION = 1;
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

function agentType(entry: Record<string, unknown>): AgentType | null {
  if (entry.type === "openai") return "openai";
  if (entry.type === "acp" || entry.type === "command") return "acp";
  if (optionalString(entry.baseUrl) && optionalString(entry.model)) return "openai";
  if (optionalString(entry.command)) return "acp";
  return null;
}

function isUsableAgent(entry: Record<string, unknown>): boolean {
  const type = agentType(entry);
  if (type === "openai") {
    return !!(optionalString(entry.baseUrl) && optionalString(entry.model));
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
    if (agent.model) agent.model = agent.model.trim();
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

  const version =
    typeof source.version === "number" && Number.isFinite(source.version)
      ? source.version
      : 0;

  const config = { ...source, version, agents } as AgentsConfig;

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

// Idempotent, version-gated migration/seed. Returns the resulting config and
// whether it changed (so callers only persist on change). `version` is the
// migration marker: its absence means "unmigrated → seed"; a present version
// with empty agents is an intentional empty state and is respected.
export function migrateAgentsConfig(
  raw: unknown,
  legacyCommand?: string,
): { config: AgentsConfig; changed: boolean } {
  const hadVersion =
    isObject(raw) &&
    typeof raw.version === "number" &&
    Number.isFinite(raw.version);
  const normalized = normalizeAgentsConfig(raw);

  if (hadVersion) {
    // Already migrated. Respect empty agents and never auto-correct an invalid
    // activeAgentId (idle re-resolves at runtime). For a future version, stay
    // non-destructive: use the cleaned shape in memory but do not persist.
    const changed =
      normalized.version <= AGENTS_CONFIG_VERSION &&
      !deepEqual(raw, normalized);
    return { config: normalized, changed };
  }

  // Unmigrated. Seed precedence: existing valid agents → legacy command →
  // copilot default.
  const config: AgentsConfig = { ...normalized, version: AGENTS_CONFIG_VERSION };
  const ids = Object.keys(config.agents);

  if (ids.length > 0) {
    // Preserve hand-written agents; only stamp version and ensure a selection.
    if (!config.activeAgentId || !config.agents[config.activeAgentId]) {
      config.activeAgentId = ids[0];
    }
    return { config, changed: true };
  }

  const command =
    typeof legacyCommand === "string" && legacyCommand.trim() !== ""
      ? legacyCommand.trim()
      : DEFAULT_AGENT_COMMAND;
  const seed = seedAgentFromCommand(command);
  config.agents = { [seed.id]: { name: seed.name, type: "acp", command } };
  config.activeAgentId = seed.id;
  return { config, changed: true };
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
): LaunchTarget {
  const type = agent.type ?? (agent.command ? "acp" : "openai");
  if (type === "openai") {
    const baseUrl = optionalString(agent.baseUrl);
    const model = optionalString(agent.model);
    if (!baseUrl || !model) {
      throw new Error(
        `API "${agent.name}" is missing baseUrl or model. Edit the agent config.`,
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
      model,
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
