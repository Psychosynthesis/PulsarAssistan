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
      `git ${sub} is not allowed. Allowed: status, diff, log, show, branch, blame, checkout, switch, add, commit.`,
    );
  }

  for (const token of argv) {
    if (BLOCKED_ANYWHERE.has(flagName(token))) {
      throw new Error(`git option ${flagName(token)} is not allowed.`);
    }
  }

  if (
    sub === "branch" &&
    argv.some(
      (token) =>
        token === "-d" ||
        token === "-D" ||
        token === "--delete" ||
        token === "-f" ||
        token === "--force",
    )
  ) {
    throw new Error("git branch delete/force is not allowed.");
  }

  if (sub === "commit") {
    if (!hasCommitMessage(argv)) {
      throw new Error('git commit requires -m "message".');
    }
    if (!argv.includes("--no-verify") && !argv.includes("-n")) {
      argv = [...argv, "--no-verify"];
    }
  }

  return {
    args: argv,
    needsPermission: WRITE.has(sub),
    title: `git ${argv.join(" ")}`,
  };
}
