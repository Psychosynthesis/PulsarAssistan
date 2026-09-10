import * as path from "path";
import * as acp from "@agentclientprotocol/sdk";
import { parseCommandLine, runCapturedProcess } from "../util";
import { globFiles, grepFiles, listDirectory } from "../grep";
import { planGitCommand } from "../git-command";
import { resolveInsideRoot } from "../project-uri";
import type { ProjectPolicy } from "../project-policy";
import type { ChatTool } from "../openai-client";

export const MAX_TOOL_ITERATIONS = 20;

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
      description: "Create or overwrite a text file in the project.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
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
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents with a JavaScript regular expression (not a shell grep). pattern is the regex source only: use function not /function/ and not function(. Escape ( ) [ ] + * ? . if you want those characters literally. path is an existing directory or file; put *.ts in glob, not in path. Works on Windows without a system grep.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            description:
              "JavaScript regex source, e.g. function or export function. Do not wrap in /slashes/.",
          },
          path: {
            type: "string",
            description:
              "Directory or file to search, relative to the project root. Not a glob.",
          },
          glob: {
            type: "string",
            description: "Optional filename glob, e.g. *.ts or **/*.py",
          },
          caseInsensitive: { type: "boolean" },
          maxResults: { type: "integer" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by glob pattern relative to the project root.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
        },
        required: ["pattern"],
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
      name: "git",
      description:
        "Run git in the project root. Always available; does not need allowCommands. Pass arguments after git, e.g. status, diff, branch, checkout -b topic, add -A, commit -m \"msg\". Not a shell. No push, pull, fetch, reset, rebase, force branch options, or --edit-description. checkout, switch, add, commit, and mutating branch operations (create, rename, delete) ask for permission. commit needs -m.",
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
      return {
        title: `Write ${path.basename(filePath)}`,
        kind: "edit",
        locations: [{ path: filePath }],
        rawInput: { path: filePath, content: stringArg(args, "content") ?? "" },
        needsPermission: true,
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
    case "grep": {
      const pattern = stringArg(args, "pattern") ?? "";
      return {
        title: `Grep ${pattern}`,
        kind: "search",
        rawInput: args,
        needsPermission: false,
      };
    }
    case "glob": {
      const pattern = stringArg(args, "pattern") ?? "";
      return {
        title: `Glob ${pattern}`,
        kind: "search",
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
): Promise<ToolSuccess> {
  if (signal.aborted) throw new Error("Cancelled.");
  const args = asRecord(rawArguments);
  switch (name) {
    case "read_file":
      return readFileTool(conn, sessionId, cwd, args);
    case "write_file":
      return writeFileTool(conn, sessionId, cwd, args);
    case "run_command":
      return runCommandTool(cwd, args, signal, policy);
    case "run_tests":
      return runTestsTool(cwd, signal, policy);
    case "grep":
      return grepTool(cwd, args);
    case "glob":
      return globTool(cwd, args);
    case "list_dir":
      return listDirTool(cwd, args);
    case "git":
      return gitTool(cwd, args, signal);
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
  const content = stringArg(args, "content") ?? "";
  let oldText: string | null = null;
  try {
    const existing = await conn.readTextFile({ sessionId, path: filePath });
    oldText = existing.content ?? "";
  } catch {
    oldText = null;
  }
  await conn.writeTextFile({ sessionId, path: filePath, content });
  return {
    output: `Wrote ${filePath}`,
    content: [{ type: "diff", path: filePath, oldText, newText: content }],
  };
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

async function grepTool(
  cwd: string,
  args: Record<string, unknown>,
): Promise<ToolSuccess> {
  const pattern = stringArg(args, "pattern");
  if (!pattern) throw new Error("grep requires a pattern.");
  const searchPath = stringArg(args, "path");
  const matches = await grepFiles({
    pattern,
    cwd,
    searchPath,
    glob: stringArg(args, "glob"),
    caseInsensitive: args.caseInsensitive === true,
    maxResults: intArg(args, "maxResults"),
  });
  if (matches.length === 0) return { output: "No matches." };
  const lines = matches.map(
    (match) => `${match.path}:${match.line}:${match.text}`,
  );
  return { output: lines.join("\n") };
}

async function globTool(
  cwd: string,
  args: Record<string, unknown>,
): Promise<ToolSuccess> {
  const pattern = stringArg(args, "pattern");
  if (!pattern) throw new Error("glob requires a pattern.");
  const matches = await globFiles({
    pattern,
    cwd,
    searchPath: stringArg(args, "path"),
  });
  if (matches.length === 0) return { output: "No files matched." };
  return { output: matches.join("\n") };
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
