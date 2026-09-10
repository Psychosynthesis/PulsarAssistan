import * as fs from "fs";
import * as path from "path";
import { resolveInsideRoot } from "./project-uri";

export const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".jj",
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  ".pulsar",
]);

export const DEFAULT_MAX_FILE_BYTES = 1 * 1024 * 1024;
export const DEFAULT_MAX_RESULTS = 50;
export const HARD_MAX_RESULTS = 200;

export type GrepMatch = {
  path: string;
  line: number;
  text: string;
};

export type GrepOptions = {
  pattern: string;
  cwd: string;
  searchPath?: string;
  glob?: string;
  caseInsensitive?: boolean;
  maxResults?: number;
  maxFileBytes?: number;
  skipDirs?: Set<string>;
};

export type GlobOptions = {
  pattern: string;
  cwd: string;
  searchPath?: string;
  maxResults?: number;
  skipDirs?: Set<string>;
};

export type ListDirEntry = {
  name: string;
  type: "file" | "directory" | "other";
};

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

// Convert a glob (`*`, `**`, `?`) to a regex. `*` does not cross `/`; `**`
// matches across directories. The pattern is matched against a posix-relative
// path from the search root.
export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  const normalized = pattern.replace(/\\/g, "/");
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        const after = normalized[i + 2];
        if (after === "/" || after === undefined) {
          source += ".*";
          i += after === "/" ? 2 : 1;
          continue;
        }
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if ("\\^$+{}()|[]".includes(char)) source += `\\${char}`;
    else source += char;
  }
  source += "$";
  return new RegExp(source);
}

export function matchGlob(relativePath: string, pattern: string): boolean {
  const posix = toPosix(relativePath);
  const regexp = globToRegExp(pattern);
  if (regexp.test(posix)) return true;
  // `*.ts` should also match `src/foo.ts` when the pattern has no slash —
  // that's how ripgrep --glob behaves for a basename filter.
  if (!pattern.includes("/") && !pattern.includes("**")) {
    return regexp.test(path.posix.basename(posix));
  }
  return false;
}

async function walkFiles(
  root: string,
  skipDirs: Set<string>,
  visit: (absolutePath: string, relativePath: string) => Promise<boolean | void>,
): Promise<void> {
  const stack: Array<{ dir: string; relative: string }> = [
    { dir: root, relative: "" },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolutePath = path.join(current.dir, entry.name);
      const relativePath = current.relative
        ? path.join(current.relative, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        stack.push({ dir: absolutePath, relative: relativePath });
        continue;
      }
      if (!entry.isFile()) continue;
      const keepGoing = await visit(absolutePath, relativePath);
      if (keepGoing === false) return;
    }
  }
}

function compilePattern(pattern: string, caseInsensitive: boolean): RegExp {
  return new RegExp(pattern, caseInsensitive ? "gi" : "g");
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

export async function grepFiles(options: GrepOptions): Promise<GrepMatch[]> {
  const cwd = path.resolve(options.cwd);
  const searchRoot = resolveInsideRoot(cwd, options.searchPath ?? ".");
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const maxResults = Math.max(
    1,
    Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS),
  );
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const regex = compilePattern(options.pattern, options.caseInsensitive === true);
  const matches: GrepMatch[] = [];

  let searchStat: fs.Stats | null = null;
  try {
    searchStat = await fs.promises.stat(searchRoot);
  } catch {
    return matches;
  }
  if (searchStat.isFile()) {
    const relativePath = path.relative(cwd, searchRoot);
    await visitFile(searchRoot, relativePath);
    return matches;
  }

  async function visitFile(
    absolutePath: string,
    relativePath: string,
  ): Promise<boolean | void> {
    if (options.glob && !matchGlob(relativePath, options.glob)) return;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absolutePath);
    } catch {
      return;
    }
    if (stat.size > maxFileBytes) return;
    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(absolutePath);
    } catch {
      return;
    }
    if (looksBinary(buffer)) return;
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (!regex.test(lines[i])) continue;
      matches.push({
        path: absolutePath,
        line: i + 1,
        text: lines[i].length > 400 ? `${lines[i].slice(0, 400)}…` : lines[i],
      });
      if (matches.length >= maxResults) return false;
    }
  }

  await walkFiles(searchRoot, skipDirs, visitFile);
  return matches;
}

export async function globFiles(options: GlobOptions): Promise<string[]> {
  const cwd = path.resolve(options.cwd);
  const searchRoot = resolveInsideRoot(cwd, options.searchPath ?? ".");
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const maxResults = Math.max(
    1,
    Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS),
  );
  const matches: string[] = [];
  await walkFiles(searchRoot, skipDirs, async (absolutePath, relativePath) => {
    if (!matchGlob(relativePath, options.pattern)) return;
    matches.push(absolutePath);
    if (matches.length >= maxResults) return false;
  });
  return matches;
}

export async function listDirectory(dirPath: string): Promise<ListDirEntry[]> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const listed: ListDirEntry[] = entries.map((entry) => {
    let type: ListDirEntry["type"] = "other";
    if (entry.isDirectory()) type = "directory";
    else if (entry.isFile()) type = "file";
    return { name: entry.name, type };
  });
  listed.sort((a, b) => a.name.localeCompare(b.name));
  return listed;
}
