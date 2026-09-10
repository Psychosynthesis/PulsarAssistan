const READ = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "blame",
  "rev-parse",
  "ls-files",
]);

const WRITE = new Set(["checkout", "switch", "add", "commit"]);

const ALLOWED = new Set([...READ, ...WRITE]);

const BLOCKED_ANYWHERE = new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--bare",
]);

const BRANCH_MUTATING = new Set([
  "-m",
  "--move",
  "-c",
  "--copy",
  "-d",
  "--delete",
  "--track",
  "--no-track",
]);

const BRANCH_BLOCKED = new Set([
  "-M",
  "-C",
  "-D",
  "-f",
  "--force",
  "--edit-description",
]);

export type GitPlan = {
  args: string[];
  needsPermission: boolean;
  title: string;
};

function flagName(token: string): string {
  return token.split("=")[0];
}

function hasCommitMessage(argv: string[]): boolean {
  for (const token of argv) {
    if (token === "-m" || token === "--message") return true;
    if (token.startsWith("--message=")) return true;
    if (/^-.*m/.test(token) && !token.startsWith("--")) return true;
  }
  return false;
}

function branchNeedsPermission(args: string[]): boolean {
  const tokens = args.slice(1);
  if (tokens.some((token) => BRANCH_MUTATING.has(flagName(token)))) {
    return true;
  }
  // `git branch <name> [<start-point>]` creates a branch. Any subcommand flag
  // makes this a read-only listing/filter form, so only bare positional args
  // count as a create request.
  return (
    tokens.length > 0 &&
    tokens.every((token) => !token.startsWith("-") && token !== "--")
  );
}

// `argv` is already split (no shell). A leading `git` token is ignored.
export function planGitCommand(argv: string[]): GitPlan {
  if (argv[0] === "git") argv = argv.slice(1);
  if (argv.length === 0) {
    throw new Error(
      'git requires arguments, e.g. status or checkout -b topic.',
    );
  }

  let i = 0;
  while (i < argv.length && argv[i].startsWith("-")) {
    const flag = flagName(argv[i]);
    if (flag === "-C" || flag === "-c" || BLOCKED_ANYWHERE.has(flag)) {
      throw new Error(`git option ${flag} is not allowed.`);
    }
    i += 1;
  }

  const sub = argv[i];
  if (!sub || sub.startsWith("-")) {
    throw new Error(
      "Pass a git subcommand first (status, diff, checkout, ...).",
    );
  }
  if (!ALLOWED.has(sub)) {
    throw new Error(
      `git ${sub} is not allowed. Allowed: status, diff, log, show, branch, blame, rev-parse, ls-files, checkout, switch, add, commit.`,
    );
  }

  const commandArgs = argv.slice(i);

  if (sub === "branch") {
    const blocked = commandArgs.find((token) =>
      BRANCH_BLOCKED.has(flagName(token)),
    );
    if (blocked) {
      throw new Error(
        `git branch option ${flagName(blocked)} is not allowed.`,
      );
    }
  }

  if (sub === "commit") {
    if (!hasCommitMessage(commandArgs)) {
      throw new Error('git commit requires -m "message".');
    }
    if (!commandArgs.includes("--no-verify") && !commandArgs.includes("-n")) {
      argv = [...argv, "--no-verify"];
    }
  }

  return {
    args: argv,
    needsPermission:
      WRITE.has(sub) ||
      (sub === "branch" && branchNeedsPermission(commandArgs)),
    title: `git ${argv.join(" ")}`,
  };
}
