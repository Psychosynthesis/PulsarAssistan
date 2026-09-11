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
import { normalizeProjectRoot, sameProjectRoot } from "../project-uri";
import { DEFAULT_MODEL_CONTEXT_WINDOWS } from "../token-estimate";

// Config glue. The agent registry lives under our namespace as sibling keys;
// the pure agent-config / project-policy modules own the logic.

export const CFG_NS = "pulsar-assistant";
export const CFG_ACTIVE = "pulsar-assistant.activeAgentId";
export const CFG_AGENTS = "pulsar-assistant.agents";
export const CFG_MODEL_CONTEXT_WINDOWS =
  "pulsar-assistant.modelContextWindows";
export { CFG_PROJECTS };
const CFG_LEGACY_COMMAND = "pulsar-assistant.command";
const CFG_LEGACY_VERSION = "pulsar-assistant.version";

function rawAgentsConfig(): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  const activeAgentId = atom.config.get(CFG_ACTIVE);
  if (activeAgentId !== undefined) raw.activeAgentId = activeAgentId;
  const agents = atom.config.get(CFG_AGENTS);
  if (agents !== undefined) raw.agents = agents;
  return raw;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readAgentsConfig(): AgentsConfig {
  return normalizeAgentsConfig(rawAgentsConfig());
}

export function writeAgentsConfig(config: AgentsConfig): void {
  // Sibling keys only. Never unset pulsar-assistant.projects — that map is
  // user-authored opt-in policy, not part of the agent registry.
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

function writeProjectPolicyField(
  projectRoot: string,
  field: "testCommand" | "maxTurnRequests" | "toolCallDelayMs",
  value: string | number | null,
): void {
  const raw = atom.config.get(CFG_PROJECTS);
  const projects: Record<string, unknown> = isObject(raw) ? { ...raw } : {};

  let targetKey: string | undefined;
  for (const existingKey of Object.keys(projects)) {
    if (sameProjectRoot(existingKey, projectRoot)) {
      targetKey = existingKey;
      break;
    }
  }
  const projectKey = targetKey ?? normalizeProjectRoot(projectRoot);
  const entry: Record<string, unknown> = isObject(projects[projectKey])
    ? { ...(projects[projectKey] as Record<string, unknown>) }
    : {};

  if (value == null) {
    delete entry[field];
  } else {
    entry[field] = value;
  }

  if (Object.keys(entry).length === 0) {
    delete projects[projectKey];
  } else {
    projects[projectKey] = entry;
  }

  atom.config.set(CFG_PROJECTS, projects);
}

export function setProjectTestCommand(
  projectRoot: string,
  value: string | null,
): void {
  writeProjectPolicyField(projectRoot, "testCommand", value);
}

// Persist only the max-turn-requests knob for one project while preserving all
// other project entries and sibling fields in `pulsar-assistant.projects`.
export function setProjectMaxTurnRequests(
  projectRoot: string,
  value: number | null,
): void {
  writeProjectPolicyField(projectRoot, "maxTurnRequests", value);
}

export function setProjectToolCallDelay(
  projectRoot: string,
  value: number | null,
): void {
  writeProjectPolicyField(projectRoot, "toolCallDelayMs", value);
}

// Runs once in activate(): seed/migrate the registry, drop the superseded
// legacy `command` and `version` scalars, and materialize the editable model
// context window map in user config when it is not customized yet.
export function migrateAgentsConfigStore(): void {
  const legacy = atom.config.get(CFG_LEGACY_COMMAND);
  const { config, changed } = migrateAgentsConfig(
    rawAgentsConfig(),
    typeof legacy === "string" ? legacy : undefined,
  );
  if (changed) writeAgentsConfig(config);
  if (legacy !== undefined) atom.config.unset(CFG_LEGACY_COMMAND);
  if (atom.config.get(CFG_LEGACY_VERSION) !== undefined) {
    atom.config.unset(CFG_LEGACY_VERSION);
  }

  const windows = atom.config.get(CFG_MODEL_CONTEXT_WINDOWS);
  if (!isObject(windows) || Object.keys(windows).length === 0) {
    atom.config.set(CFG_MODEL_CONTEXT_WINDOWS, {
      ...DEFAULT_MODEL_CONTEXT_WINDOWS,
    });
  }
}
