import * as path from "path";
import * as acp from "@agentclientprotocol/sdk";
import { parseCommandLine, runCapturedProcess } from "../util";
import { findFiles, grepFiles, listDirectory } from "../grep";
import { planGitCommand } from "../git-command";
import { resolveInsideRoot } from "../project-uri";
import { ProjectFileTree } from "../file-btree";
import type { ProjectPolicy } from "../project-policy";
import type { ChatTool } from "../openai-client";

export const MAX_TOOL_ITERATIONS = 200;

export const TOOL_DEFINITIONS: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file in the project. Path may be absolute or relative to the project root.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          line: {
            type: "integer",
            description: "1-based start line. Omit to read from the start.",
          },
          limit: {
            type: "integer",
            description: "Maximum number of lines to return.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create, overwrite, or patch a text file in the project. Pass `content` to replace the whole file, or pass `searchText` and `replaceText` to replace all occurrences of searchText. Writing inside .git is not allowed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: {
            type: "string",
            description:
              "Full new file content. Use either this or searchText/replaceText.",
          },
          searchText: {
            type: "string",
            description: "Text to find and replace in the existing file.",
          },
          replaceText: {
            type: "string",
            description: "Replacement for every occurrence of searchText.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description:
        "Move a file within the project. Both source and destination must stay inside the project; destination must not already exist.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourcePath: {
            type: "string",
            description:
              "Absolute or project-relative path of the file to move.",
          },
          destinationPath: {
            type: "string",
            description:
              "Absolute or project-relative destination path, including filename.",
          },
        },
        required: ["sourcePath", "destinationPath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description:
        "Find files matching a search pattern and/or extensions. Pattern supports DSL: * (wildcard), ? (single character), | (OR), & (AND), \\ (escape special chars). Pattern matches file basename only. Works fast using project index.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Directory to search in, relative to project root. Defaults to '.' (root).",
          },
          pattern: {
            type: "string",
            description: "DSL search pattern (*, ?, |, &, \\). Applied to file basename.",
          },
          extensions: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of file extensions to filter by (e.g. ['ts', 'js'] or ['.ts', '.js']).",
          },
          caseInsensitive: {
            type: "boolean",
            description: "Case-insensitive matching for pattern and extensions.",
          },
          maxResults: {
            type: "integer",
            description: "Maximum number of files to return (default 100).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_file_structure",
      description:
        "Get project file structure using TSV line protocol (F\\t<path>\\tsize=<bytes>). Supports directory and depth filtering.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Directory to get structure for, relative to project root. Defaults to '.' (entire project).",
          },
          depth: {
            type: "integer",
            description: "Maximum depth of folder nesting to display (default 5).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories in a project folder.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Fast literal substring search in file contents (no regex, no glob).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Literal text to search for (substring).",
          },
          pattern: {
            type: "string",
            description: "Alias for query.",
          },
          path: {
            type: "string",
            description: "Directory or file to search in, relative to project root. Defaults to '.'.",
          },
          caseInsensitive: { type: "boolean" },
          maxResults: { type: "integer" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git",
      description:
        "Run git in the project root. Always available; does not need allowCommands. Pass arguments after git, e.g. status, diff, branch, checkout -b topic, add -A, commit -m \"msg\". Not a shell. No push, pull, fetch, reset, rebase, force branch options, or --edit-description. checkout, switch, add, commit, apply, and mutating branch operations (create, rename, delete) ask for permission. apply --check is read-only. commit needs -m.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: {
            type: "string",
            description:
              'Arguments after git, e.g. status or checkout -b topic. You may include a leading "git".',
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a process in the project when the user has enabled allowCommands for this folder in Pulsar user config (not in the repo). Pass the executable and arguments as a single command line (quoted paths allowed). Not a shell.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string" },
          cwd: {
            type: "string",
            description: "Optional working directory inside the project.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description:
        "Run the test command the user configured for this project in Pulsar user config (testCommand). You cannot choose or change the command.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  },
];

export function toolsForPolicy(policy: ProjectPolicy): ChatTool[] {
  return TOOL_DEFINITIONS.filter((tool) => {
    const name = tool.function.name;
    if (name === "run_command") return policy.allowCommands;
    if (name === "run_tests") return !!policy.testCommand;
    return true;
  });
}

export type ToolKind = acp.ToolKind;

export type BuiltinHost = {
  sessionUpdate(
    params: acp.SessionNotification,
  ): Promise<void>;
  requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse>;
  readTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse>;
  writeTextFile(
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse | void>;
  moveTextFile(params: {
    sessionId: acp.SessionId;
    sourcePath: string;
    destinationPath: string;
  }): Promise<void>;
  onStatusNote?: (note: string) => void;
  onThought?: (thought: string) => void;
};

export type ToolMeta = {
  title: string;
  kind: ToolKind;
  locations?: acp.ToolCallLocation[];
  rawInput: Record<string, unknown>;
  needsPermission: boolean;
};

export type ToolSuccess = {
  output: string;
  content?: acp.ToolCallContent[];
};

export class ToolRejected extends Error {
  constructor(message = "The user rejected this tool call.") {
    super(message);
    this.name = "ToolRejected";
  }
}

function asRecord(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function intArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

function assertWritablePath(cwd: string, filePath: string): void {
  const rel = path.relative(path.resolve(cwd), filePath);
  if (rel === ".git" || rel.startsWith(`.git${path.sep}`)) {
    throw new Error(`Writing into .git is not allowed: ${filePath}`);
  }
}

export function describeToolCall(
  name: string,
  rawArguments: string,
  cwd: string,
  policy: ProjectPolicy,
): ToolMeta {
  const args = asRecord(rawArguments);
  switch (name) {
    case "read_file": {
      const filePath = resolveInsideRoot(cwd, stringArg(args, "path") ?? ".");
      return {
        title: `Read ${path.basename(filePath)}`,
        kind: "read",
        locations: [{ path: filePath }],
        rawInput: { path: filePath, line: args.line, limit: args.limit },
        needsPermission: false,
      };
    }
    case "write_file": {
      const filePath = resolveInsideRoot(cwd, stringArg(args, "path") ?? ".");
      assertWritablePath(cwd, filePath);
      const rawInput: Record<string, unknown> = { path: filePath };
      if (stringArg(args, "content") !== undefined) {
        rawInput.content = stringArg(args, "content");
      } else {
        rawInput.searchText = stringArg(args, "searchText");
        rawInput.replaceText = stringArg(args, "replaceText");
      }
      return {
        title: `Edit ${path.basename(filePath)}`,
        kind: "edit",
        locations: [{ path: filePath }],
        rawInput,
        needsPermission: true,
      };
    }
    case "move_file": {
      const sourcePath = resolveInsideRoot(
        cwd,
        stringArg(args, "sourcePath") ?? ".",
      );
      const destinationPath = resolveInsideRoot(
        cwd,
        stringArg(args, "destinationPath") ?? ".",
      );
      assertWritablePath(cwd, sourcePath);
      assertWritablePath(cwd, destinationPath);
      return {
        title: `Move ${path.basename(sourcePath)}`,
        kind: "edit",
        locations: [{ path: sourcePath }, { path: destinationPath }],
        rawInput: { sourcePath, destinationPath },
        needsPermission: true,
      };
    }
    case "find_files": {
      const pattern = stringArg(args, "pattern") ?? "*";
      const extensions = Array.isArray(args.extensions)
        ? args.extensions.join(",")
        : "";
      const searchPath = stringArg(args, "path") ?? ".";
      const desc = extensions ? `${pattern} (${extensions})` : pattern;
      return {
        title: `Find ${desc} in ${searchPath}`,
        kind: "search",
        rawInput: args,
        needsPermission: false,
      };
    }
    case "get_file_structure": {
      const searchPath = stringArg(args, "path") ?? ".";
      const depth = intArg(args, "depth") ?? 5;
      return {
        title: `Structure of ${searchPath} (depth ${depth})`,
        kind: "read",
        rawInput: args,
        needsPermission: false,
      };
    }
    case "list_dir": {
      const dirPath = resolveInsideRoot(cwd, stringArg(args, "path") ?? ".");
      return {
        title: `List ${path.basename(dirPath) || dirPath}`,
        kind: "read",
        locations: [{ path: dirPath }],
        rawInput: { path: dirPath },
        needsPermission: false,
      };
    }
    case "grep": {
      const query =
        stringArg(args, "query") ?? stringArg(args, "pattern") ?? "";
      const searchPath = stringArg(args, "path") ?? ".";
      return {
        title: `Grep "${query}" in ${searchPath}`,
        kind: "search",
        rawInput: args,
        needsPermission: false,
      };
    }
    case "git": {
      const plan = planGitCommand(
        parseCommandLine(stringArg(args, "command") ?? ""),
      );
      return {
        title: plan.title,
        kind: plan.needsPermission ? "execute" : "read",
        rawInput: { command: plan.args.join(" ") },
        needsPermission: plan.needsPermission,
      };
    }
    case "run_command": {
      if (!policy.allowCommands) {
        throw new Error(
          "Commands are disabled for this project. Set allowCommands: true under pulsar-assistant.projects in Pulsar user config (not in the project folder).",
        );
      }
      const command = stringArg(args, "command") ?? "";
      return {
        title: command ? `Run ${command}` : "Run command",
        kind: "execute",
        rawInput: { command, cwd: stringArg(args, "cwd") ?? cwd },
        needsPermission: true,
      };
    }
    case "run_tests": {
      const command = policy.testCommand;
      if (!command) {
        throw new Error(
          "No test command configured. Set testCommand under pulsar-assistant.projects in Pulsar user config for this folder (not in the project folder).",
        );
      }
      return {
        title: `Test ${command}`,
        kind: "execute",
        rawInput: { command },
        needsPermission: false,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function requestToolPermission(
  conn: BuiltinHost,
  sessionId: string,
  toolCallId: string,
  meta: ToolMeta,
): Promise<boolean> {
  const response = await conn.requestPermission({
    sessionId,
    toolCall: {
      toolCallId,
      title: meta.title,
      kind: meta.kind,
      status: "pending",
      locations: meta.locations,
      rawInput: meta.rawInput,
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  if (response.outcome.outcome === "cancelled") return false;
  return response.outcome.optionId === "allow-once";
}

export async function executeTool(
  conn: BuiltinHost,
  sessionId: string,
  name: string,
  rawArguments: string,
  cwd: string,
  signal: AbortSignal,
  policy: ProjectPolicy,
  fileTree?: ProjectFileTree | null,
): Promise<ToolSuccess> {
  if (signal.aborted) throw new Error("Cancelled.");
  const args = asRecord(rawArguments);
  switch (name) {
    case "read_file":
      return readFileTool(conn, sessionId, cwd, args);
    case "write_file":
      return writeFileTool(conn, sessionId, cwd, args);
    case "move_file":
      return moveFileTool(conn, sessionId, cwd, args);
    case "find_files":
      return findFilesTool(cwd, args, fileTree);
    case "get_file_structure":
      return getFileStructureTool(cwd, args, fileTree);
    case "list_dir":
      return listDirTool(cwd, args);
    case "grep":
      return grepTool(cwd, args, fileTree);
    case "git":
      return gitTool(cwd, args, signal);
    case "run_command":
      return runCommandTool(cwd, args, signal, policy);
    case "run_tests":
      return runTestsTool(cwd, signal, policy);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function readFileTool(
  conn: BuiltinHost,
  sessionId: string,
  cwd: string,
  args: Record<string, unknown>,
): Promise<ToolSuccess> {
  const filePath = resolveInsideRoot(cwd, stringArg(args, "path") ?? ".");
  const result = await conn.readTextFile({
    sessionId,
    path: filePath,
    line: intArg(args, "line") ?? null,
    limit: intArg(args, "limit") ?? null,
  });
  return { output: result.content ?? "" };
}

async function writeFileTool(
  conn: BuiltinHost,
  sessionId: string,
  cwd: string,
  args: Record<string, unknown>,
): Promise<ToolSuccess> {
  const filePath = resolveInsideRoot(cwd, stringArg(args, "path") ?? ".");
  assertWritablePath(cwd, filePath);

  const fullContent = stringArg(args, "content");
  const searchText = stringArg(args, "searchText");
  const replaceText = stringArg(args, "replaceText");

  if (fullContent !== undefined && searchText !== undefined) {
    throw new Error(
      "write_file accepts either `content` or `searchText`+`replaceText`, not both.",
    );
  }

  let oldText: string | null = null;
  try {
    const existing = await conn.readTextFile({ sessionId, path: filePath });
    oldText = existing.content ?? "";
  } catch {
    oldText = null;
  }

  let newContent: string;
  let replacedCount = 0;

  if (searchText !== undefined) {
    if (replaceText === undefined) {
      throw new Error("write_file `searchText` requires `replaceText`.");
    }
    if (searchText.length === 0) {
      throw new Error("write_file `searchText` must not be empty.");
    }
    const current = oldText ?? "";
    const parts = current.split(searchText);
    if (parts.length === 1) {
      throw new Error(`Search text not found in ${filePath}`);
    }
    replacedCount = parts.length - 1;
    newContent = parts.join(replaceText);
  } else {
    if (fullContent === undefined) {
      throw new Error(
        "write_file requires either `content` or `searchText`+`replaceText`.",
      );
    }
    newContent = fullContent;
  }

  await conn.writeTextFile({ sessionId, path: filePath, content: newContent });
  return {
    output:
      searchText !== undefined
        ? `Replaced ${replacedCount} occurrence${replacedCount === 1 ? "" : "s"} in ${filePath}`
        : `Wrote ${filePath}`,
    content: [
      { type: "diff", path: filePath, oldText, newText: newContent },
    ],
  };
}

async function moveFileTool(
  conn: BuiltinHost,
  sessionId: string,
  cwd: string,
  args: Record<string, unknown>,
): Promise<ToolSuccess> {
  const sourcePath = resolveInsideRoot(
    cwd,
    stringArg(args, "sourcePath") ?? ".",
  );
  const destinationPath = resolveInsideRoot(
    cwd,
    stringArg(args, "destinationPath") ?? ".",
  );
  assertWritablePath(cwd, sourcePath);
  assertWritablePath(cwd, destinationPath);
  await conn.moveTextFile({ sessionId, sourcePath, destinationPath });
  return { output: `Moved ${sourcePath} -> ${destinationPath}` };
}

async function findFilesTool(
  cwd: string,
  args: Record<string, unknown>,
  fileTree?: ProjectFileTree | null,
): Promise<ToolSuccess> {
  const pattern = stringArg(args, "pattern");
  const searchPath = stringArg(args, "path");
  const extensions = Array.isArray(args.extensions)
    ? (args.extensions.filter((x) => typeof x === "string") as string[])
    : undefined;
  const matches = await findFiles({
    pattern,
    extensions,
    cwd,
    searchPath,
    caseInsensitive: args.caseInsensitive === true,
    maxResults: intArg(args, "maxResults"),
    fileTree,
  });
  if (matches.length === 0) return { output: "No files matched." };
  return { output: matches.join("\n") };
}

async function getFileStructureTool(
  cwd: string,
  args: Record<string, unknown>,
  fileTree?: ProjectFileTree | null,
): Promise<ToolSuccess> {
  const searchPath = stringArg(args, "path") ?? ".";
  const depth = intArg(args, "depth") ?? 5;
  if (fileTree && fileTree.size > 0) {
    const text = fileTree.toHierarchyText(500, searchPath, depth);
    return { output: text };
  }
  const tree = new ProjectFileTree(cwd);
  await tree.scanProject();
  const text = tree.toHierarchyText(500, searchPath, depth);
  return { output: text };
}

async function grepTool(
  cwd: string,
  args: Record<string, unknown>,
  fileTree?: ProjectFileTree | null,
): Promise<ToolSuccess> {
  const query = stringArg(args, "query") ?? stringArg(args, "pattern");
  if (!query) throw new Error("grep requires a query string.");
  const searchPath = stringArg(args, "path");
  const matches = await grepFiles({
    query,
    cwd,
    searchPath,
    caseInsensitive: args.caseInsensitive === true,
    maxResults: intArg(args, "maxResults"),
    fileTree,
  });
  if (matches.length === 0) return { output: "No matches." };
  const lines = matches.map(
    (match) => `${match.path}:${match.line}:${match.text}`,
  );
  return { output: lines.join("\n") };
}

async function listDirTool(
  cwd: string,
  args: Record<string, unknown>,
): Promise<ToolSuccess> {
  const dirPath = resolveInsideRoot(cwd, stringArg(args, "path") ?? ".");
  const entries = await listDirectory(dirPath);
  if (entries.length === 0) return { output: "(empty)" };
  const lines = entries.map((entry) =>
    entry.type === "directory" ? `${entry.name}/` : entry.name,
  );
  return { output: lines.join("\n") };
}

async function gitTool(
  cwd: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolSuccess> {
  const commandLine = stringArg(args, "command");
  if (!commandLine) throw new Error("git requires a command string.");
  const plan = planGitCommand(parseCommandLine(commandLine));
  return formatProcessResult(
    await runCapturedProcess({
      command: "git",
      args: plan.args,
      cwd,
      signal,
    }),
  );
}

async function runCommandTool(
  cwd: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  policy: ProjectPolicy,
): Promise<ToolSuccess> {
  if (!policy.allowCommands) {
    throw new Error(
      "Commands are disabled for this project. Set allowCommands: true under pulsar-assistant.projects in Pulsar user config (not in the project folder).",
    );
  }
  const commandLine = stringArg(args, "command");
  if (!commandLine) throw new Error("run_command requires a command string.");
  const argv = parseCommandLine(commandLine);
  const command = argv[0];
  if (!command) throw new Error("run_command command is empty.");
  const commandCwd = resolveInsideRoot(cwd, stringArg(args, "cwd") ?? ".");
  return formatProcessResult(
    await runCapturedProcess({
      command,
      args: argv.slice(1),
      cwd: commandCwd,
      signal,
    }),
  );
}

async function runTestsTool(
  cwd: string,
  signal: AbortSignal,
  policy: ProjectPolicy,
): Promise<ToolSuccess> {
  const commandLine = policy.testCommand;
  if (!commandLine) {
    throw new Error(
      "No test command configured. Set testCommand under pulsar-assistant.projects in Pulsar user config for this folder (not in the project folder).",
    );
  }
  const argv = parseCommandLine(commandLine);
  const command = argv[0];
  if (!command) throw new Error("Configured testCommand is empty.");
  return formatProcessResult(
    await runCapturedProcess({
      command,
      args: argv.slice(1),
      cwd,
      signal,
    }),
  );
}

function formatProcessResult(result: {
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
}): ToolSuccess {
  const status =
    result.exitCode != null
      ? `exit ${result.exitCode}`
      : result.signal
        ? `signal ${result.signal}`
        : "exited";
  const truncated = result.truncated ? "\n(output truncated)" : "";
  return { output: `${status}\n${result.output}${truncated}`.trim() };
}
