import * as path from "path";

export const PULSAR_ACP_AGENT_URI_PREFIX = "atom://pulsar-assistant/project/";

export function normalizeProjectRoot(projectRoot: string): string {
  return path.resolve(projectRoot);
}

export function uriForProject(projectRoot: string): string {
  return (
    PULSAR_ACP_AGENT_URI_PREFIX +
    encodeURIComponent(normalizeProjectRoot(projectRoot))
  );
}

export function parseAgentUri(uri: string): string | null {
  if (!uri.startsWith(PULSAR_ACP_AGENT_URI_PREFIX)) return null;
  try {
    const decoded = decodeURIComponent(
      uri.slice(PULSAR_ACP_AGENT_URI_PREFIX.length),
    );
    if (!decoded) return null;
    return normalizeProjectRoot(decoded);
  } catch {
    return null;
  }
}

export function sameProjectRoot(a: string, b: string): boolean {
  const left = normalizeProjectRoot(a);
  const right = normalizeProjectRoot(b);
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

export function projectFolderName(projectRoot: string): string {
  const base = path.basename(normalizeProjectRoot(projectRoot));
  return base || projectRoot;
}

export function resolveInsideRoot(cwd: string, requested: string): string {
  const root = path.resolve(cwd);
  const target = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the project: ${requested}`);
  }
  return target;
}
