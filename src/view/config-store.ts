import {
  AgentsConfig,
  migrateAgentsConfig,
  normalizeAgentsConfig,
} from "../agent-config";
import {
  CFG_PROJECTS,
  resolveProjectPolicy,
  type ProjectPolicy,
} from "../project-policy";

// Config glue. The agent registry lives under our namespace as sibling keys;
// the pure agent-config / project-policy modules own the logic.

export const CFG_NS = "pulsar-assistant";
export const CFG_VERSION = "pulsar-assistant.version";
export const CFG_ACTIVE = "pulsar-assistant.activeAgentId";
export const CFG_AGENTS = "pulsar-assistant.agents";
export { CFG_PROJECTS };
const CFG_LEGACY_COMMAND = "pulsar-assistant.command";

function rawAgentsConfig(): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  const version = atom.config.get(CFG_VERSION);
  if (version !== undefined) raw.version = version;
  const activeAgentId = atom.config.get(CFG_ACTIVE);
  if (activeAgentId !== undefined) raw.activeAgentId = activeAgentId;
  const agents = atom.config.get(CFG_AGENTS);
  if (agents !== undefined) raw.agents = agents;
  return raw;
}

export function readAgentsConfig(): AgentsConfig {
  return normalizeAgentsConfig(rawAgentsConfig());
}

export function writeAgentsConfig(config: AgentsConfig): void {
  // Sibling keys only. Never unset pulsar-assistant.projects — that map is
  // user-authored opt-in policy, not part of the agent registry.
  atom.config.set(CFG_VERSION, config.version);
  atom.config.set(CFG_AGENTS, config.agents);
  if (config.activeAgentId) atom.config.set(CFG_ACTIVE, config.activeAgentId);
  else atom.config.unset(CFG_ACTIVE);
}

export function setActiveAgentId(id: string): void {
  // Last-used default for the *next newly opened* panel. Not a per-project map.
  atom.config.set(CFG_ACTIVE, id);
}

export function readProjectPolicy(projectRoot: string): ProjectPolicy {
  return resolveProjectPolicy(projectRoot, atom.config.get(CFG_PROJECTS));
}

// Runs once in activate(): seed/migrate the registry and drop the superseded
// legacy `command` scalar. Persists only when something changed.
export function migrateAgentsConfigStore(): void {
  const legacy = atom.config.get(CFG_LEGACY_COMMAND);
  const { config, changed } = migrateAgentsConfig(
    rawAgentsConfig(),
    typeof legacy === "string" ? legacy : undefined,
  );
  if (changed) writeAgentsConfig(config);
  if (legacy !== undefined) atom.config.unset(CFG_LEGACY_COMMAND);
}
