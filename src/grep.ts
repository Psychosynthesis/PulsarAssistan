import * as fs from "fs";
import * as path from "path";
import { resolveInsideRoot } from "./project-uri";
import {
  buildIgnoredDirsSet,
  getConfiguredIgnoredDirs,
} from "./ignored-dirs";
import type { ProjectFileTree } from "./file-btree";

export const DEFAULT_SKIP_DIRS: Set<string> = buildIgnoredDirsSet();

export const DEFAULT_MAX_FILE_BYTES = 1 * 1024 * 1024;
export const DEFAULT_MAX_RESULTS = 100;
export const HARD_MAX_RESULTS = 500;

export type GrepMatch = {
  path: string;
  line: number;
  text: string;
};

export type GrepOptions = {
  query: string;
  cwd: string;
  searchPath?: string;
  caseInsensitive?: boolean;
  maxResults?: number;
  maxFileBytes?: number;
  skipDirs?: Set<string>;
  fileTree?: ProjectFileTree | null;
};

export type FindFilesOptions = {
  cwd: string;
  searchPath?: string;
  pattern?: string;
  extensions?: string[];
  caseInsensitive?: boolean;
  maxResults?: number;
  skipDirs?: Set<string>;
  fileTree?: ProjectFileTree | null;
};

export type ListDirEntry = {
  name: string;
  type: "file" | "directory" | "other";
};

function splitUnescaped(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\") {
      current += ch;
      if (i + 1 < input.length) {
        current += input[i + 1];
        i++;
      }
      continue;
    }
    if (ch === delimiter) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

function atomToRegExp(atom: string, caseInsensitive: boolean): RegExp {
  let regexStr = "^";
  let i = 0;
  while (i < atom.length) {
    const ch = atom[i];
    if (ch === "\\") {
      if (i + 1 < atom.length) {
        const next = atom[i + 1];
        if ("\\^$+{}()|[]*?.#".includes(next)) {
          regexStr += `\\${next}`;
        } else {
          regexStr += next;
        }
        i += 2;
        continue;
      } else {
        regexStr += "\\\\";
        i++;
        continue;
      }
    }
    if (ch === "*") {
      regexStr += ".*";
      i++;
      continue;
    }
    if (ch === "?") {
      regexStr += ".";
      i++;
      continue;
    }
    if ("\\^$+{}()|[]*.#".includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
    i++;
  }
  regexStr += "$";
  return new RegExp(regexStr, caseInsensitive ? "i" : "");
}

export type DslMatcher = (basename: string) => boolean;

export function parseDslPattern(
  pattern?: string,
  caseInsensitive = false,
): DslMatcher {
  if (!pattern || !pattern.trim()) {
    return () => true;
  }
  const orBranches = splitUnescaped(pattern, "|").filter((s) => s.length > 0);
  if (orBranches.length === 0) {
    return () => true;
  }
  const compiledOrBranches: RegExp[][] = orBranches.map((branch) => {
    const andTerms = splitUnescaped(branch, "&").filter((s) => s.length > 0);
    return andTerms.map((term) => atomToRegExp(term, caseInsensitive));
  });

  return (basename: string) => {
    return compiledOrBranches.some((andTerms) =>
      andTerms.every((regex) => regex.test(basename)),
    );
  };
}

export function makeExtensionsMatcher(
  extensions?: string[],
  caseInsensitive = false,
): (basename: string) => boolean {
  if (!extensions || extensions.length === 0) {
    return () => true;
  }
  const normalized = extensions
    .map((ext) => {
      const trimmed = ext.trim().replace(/^\./, "");
      return caseInsensitive ? trimmed.toLowerCase() : trimmed;
    })
    .filter(Boolean);

  if (normalized.length === 0) return () => true;

  const set = new Set(normalized);
  return (basename: string) => {
    const ext = path.extname(basename).replace(/^\./, "");
    const target = caseInsensitive ? ext.toLowerCase() : ext;
    return set.has(target);
  };
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
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
    entries.sort((a, b) => a.name.localeCompare(b.name));
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

export async function findFiles(options: FindFilesOptions): Promise<string[]> {
  const cwd = path.resolve(options.cwd);
  const searchRoot = resolveInsideRoot(cwd, options.searchPath ?? ".");
  const skipDirs = options.skipDirs ?? getConfiguredIgnoredDirs();
  const maxResults = Math.max(
    1,
    Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS),
  );
  const dslMatcher = parseDslPattern(options.pattern, options.caseInsensitive === true);
  const extMatcher = makeExtensionsMatcher(options.extensions, options.caseInsensitive === true);
  const matches: string[] = [];

  const searchRel = path.relative(cwd, searchRoot).replace(/\\/g, "/");

  if (options.fileTree && options.fileTree.size > 0) {
    const all = searchRel === "" || searchRel === "."
      ? options.fileTree.listAll()
      : options.fileTree.findInDirectory(searchRel);

    for (const item of all) {
      if (item.isDirectory) continue;
      const basename = path.posix.basename(item.path);
      if (dslMatcher(basename) && extMatcher(basename)) {
        matches.push(path.resolve(cwd, item.path));
        if (matches.length >= maxResults) break;
      }
    }
    return matches;
  }

  await walkFiles(searchRoot, skipDirs, async (absolutePath) => {
    const basename = path.basename(absolutePath);
    if (!dslMatcher(basename) || !extMatcher(basename)) return;
    matches.push(absolutePath);
    if (matches.length >= maxResults) return false;
  });
  return matches;
}

export async function grepFiles(options: GrepOptions): Promise<GrepMatch[]> {
  const cwd = path.resolve(options.cwd);
  const searchRoot = resolveInsideRoot(cwd, options.searchPath ?? ".");
  const skipDirs = options.skipDirs ?? getConfiguredIgnoredDirs();
  const maxResults = Math.max(
    1,
    Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS),
  );
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const matches: GrepMatch[] = [];
  const query = options.caseInsensitive ? options.query.toLowerCase() : options.query;

  if (!query) {
    return matches;
  }

  let searchStat: fs.Stats | null = null;
  try {
    searchStat = await fs.promises.stat(searchRoot);
  } catch {
    return matches;
  }
  if (searchStat.isFile()) {
    await searchSingleFile(searchRoot);
    return matches;
  }

  async function searchSingleFile(absolutePath: string): Promise<boolean | void> {
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
      const line = lines[i];
      const target = options.caseInsensitive ? line.toLowerCase() : line;
      if (!target.includes(query)) continue;
      matches.push({
        path: absolutePath,
        line: i + 1,
        text: lines[i].length > 400 ? `${lines[i].slice(0, 400)}…` : lines[i],
      });
      if (matches.length >= maxResults) return false;
    }
  }

  const searchRel = path.relative(cwd, searchRoot).replace(/\\/g, "/");

  if (options.fileTree && options.fileTree.size > 0) {
    const all = searchRel === "" || searchRel === "."
      ? options.fileTree.listAll()
      : options.fileTree.findInDirectory(searchRel);

    for (const item of all) {
      if (item.isDirectory) continue;
      const abs = path.resolve(cwd, item.path);
      const keep = await searchSingleFile(abs);
      if (keep === false) break;
    }
    return matches;
  }

  await walkFiles(searchRoot, skipDirs, async (absolutePath) => {
    const keep = await searchSingleFile(absolutePath);
    if (keep === false) return false;
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
