import {
  normalizeProjectRoot,
  parseAgentUri,
  projectFolderName,
  sameProjectRoot,
  uriForProject,
} from "./project-uri";

export {
  PULSAR_ACP_AGENT_URI_PREFIX,
  normalizeProjectRoot,
  parseAgentUri,
  projectFolderName,
  sameProjectRoot,
  uriForProject,
} from "./project-uri";

export function projectRootForFile(
  filePath: string | null | undefined,
): string | null {
  if (!filePath) return null;
  const [root] = atom.project.relativizePath(filePath);
  return root ? normalizeProjectRoot(root) : null;
}

export function isOpenProjectRoot(projectRoot: string): boolean {
  const target = normalizeProjectRoot(projectRoot);
  return atom.project.getPaths().some((root) => sameProjectRoot(root, target));
}

export function resolveCurrentProjectRoot(
  filePath?: string | null,
): string | null {
  const fromFile = projectRootForFile(filePath);
  if (fromFile) return fromFile;
  const paths = atom.project.getPaths();
  if (paths.length === 1) return normalizeProjectRoot(paths[0]);
  return null;
}
