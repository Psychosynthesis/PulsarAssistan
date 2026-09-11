export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  // Version control
  ".git",
  ".hg",
  ".svn",
  ".jj",
  // Dependencies & package managers
  "node_modules",
  ".pnpm-store",
  ".yarn",
  "vendor",
  ".bundle",
  ".cargo",
  ".rustup",
  // Build outputs & caches
  "dist",
  "build",
  "out",
  ".output",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".gradle",
  // Test coverage & reports
  "coverage",
  ".nyc_output",
  // Python environments & caches
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  // IDEs & editors
  ".idea",
  ".vscode",
  ".pulsar",
];

const DEFAULT_IGNORED_SET = new Set<string>(DEFAULT_IGNORED_DIRS);

export function isDefaultIgnoredDir(name: string): boolean {
  return DEFAULT_IGNORED_SET.has(name);
}

export function buildIgnoredDirsSet(customDirs?: Iterable<string>): Set<string> {
  const set = new Set<string>(DEFAULT_IGNORED_SET);
  if (customDirs) {
    for (const dir of customDirs) {
      const trimmed = dir.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return set;
}

/**
 * Returns configured ignored directories from Pulsar configuration if available.
 */
export function getConfiguredIgnoredDirs(): Set<string> {
  if (typeof atom !== "undefined" && atom?.config?.get) {
    const custom = atom.config.get("pulsar-assistant.ignoredDirectories");
    if (Array.isArray(custom)) {
      return buildIgnoredDirsSet(custom.filter((x): x is string => typeof x === "string"));
    }
  }
  return new Set<string>(DEFAULT_IGNORED_SET);
}
