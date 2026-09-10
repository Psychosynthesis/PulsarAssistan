import * as fs from "fs";
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

// Resolve symlinks for the deepest existing ancestor and append the missing
// suffix, so containment checks still work for paths that do not exist yet
// (e.g. write_file to a new file).
function resolveRealPath(filePath: string): string {
  const target = path.resolve(filePath);
  let current = target;
  const missing: string[] = [];
  while (true) {
    try {
      const real = fs.realpathSync(current);
      return missing.length > 0 ? path.join(real, ...missing) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
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

  // Follow symlinks before accepting the path. A symlink inside the project can
  // point outside it; `path.relative` above would still see the lexical path.
  const realRoot = resolveRealPath(root);
  const realTarget = resolveRealPath(target);
  const realRel = path.relative(realRoot, realTarget);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error(`Path is outside the project: ${requested}`);
  }

  return target;
}
