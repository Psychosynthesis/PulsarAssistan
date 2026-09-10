import { normalizeProjectRoot, sameProjectRoot } from "./project-uri";

// Opt-in process policy for one project folder. Lives in Pulsar user config
// (`pulsar-assistant.projects`), never inside the project tree — an agent with
// write_file cannot grant itself commands by editing the repo.

export const CFG_PROJECTS = "pulsar-assistant.projects";

export type ProjectPolicy = {
  allowCommands: boolean;
  testCommand: string | null;
  maxTurnRequests: number | null;
};

const DENY: ProjectPolicy = {
  allowCommands: false,
  testCommand: null,
  maxTurnRequests: null,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return null;
  }
  return Math.trunc(value);
}

export function resolveProjectPolicy(
  projectRoot: string,
  projects: unknown,
): ProjectPolicy {
  if (!isObject(projects)) return DENY;
  const root = normalizeProjectRoot(projectRoot);
  for (const [key, value] of Object.entries(projects)) {
    if (!key || !isObject(value) || !sameProjectRoot(key, root)) continue;
    return {
      allowCommands: value.allowCommands === true,
      testCommand: optionalString(value.testCommand) ?? null,
      maxTurnRequests: positiveInt(value.maxTurnRequests),
    };
  }
  return DENY;
}
