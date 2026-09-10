# Pulsar Assistant

[![Version](https://img.shields.io/github/package-json/v/Psychosynthesis/PulsarAssistan)](https://packages.pulsar-edit.dev/packages/pulsar-assistant)
[![Pulsar downloads](https://img.shields.io/pulsar/dt/PulsarAssistan)](https://packages.pulsar-edit.dev/packages/pulsar-assistant)
[![CI](https://img.shields.io/github/actions/workflow/status/Psychosynthesis/PulsarAssistan/ci.yml?branch=main&label=CI)](https://github.com/Psychosynthesis/PulsarAssistan/actions/workflows/ci.yml)

A simple, minimalist plugin that provides coding assistant functionality using any model into [Pulsar](https://pulsar-edit.dev),
without the need to run a full-fledged ACP agent locally.

Support [Agent Client Protocol (ACP)](https://agentclientprotocol.com)-compatible agents such as `Copilot CLI / Vibe`.

Uses some modules of the code from the project <https://github.com/hovancik/pulsar-acp-agent>.

_Pulsar Assistant running an ACP-compatible coding agent inside Pulsar._

Highlights:

- Open a separate ACP panel per project folder. ACP stays off until you open it for that project.
- Talk to an OpenAI-compatible API from inside Pulsar, or spawn a local ACP CLI such as `Copilot CLI / Vibe`.
- Attach the current file or selection to prompts.
- Review permission prompts, tool output, diffs, plans, and session history inline.
- Configure and switch between APIs from the panel header.


The builtin agent is the primary path. Spawned ACP CLIs remain supported as a
fallback. Currently tested with GitHub Copilot CLI and Mistral Vibe.

## Table of contents

- [Install](#install)
- [Open a panel](#open-a-panel)
- [Configure APIs and agents](#configure-apis-and-agents)
  - [Example: OpenAI-compatible API](#example-openai-compatible-api)
  - [Project commands and tests](#project-commands-and-tests)
  - [Example: Copilot CLI](#example-copilot-cli)
  - [Selecting an agent and model](#selecting-an-agent-and-model)
- [Develop](#develop)
- [Architecture](#architecture)
- [Testing](#testing)
- [Supported ACP features](#supported-acp-features)
- [Security](#security)

## Install

In Pulsar, open **Settings → Install**, search for `pulsar-assistant`, and click
**Install**. Or from a terminal:

```sh
ppm install pulsar-assistant
```

Package page: <https://packages.pulsar-edit.dev/packages/pulsar-assistant>

## Open a panel

ACP is off until you open it for a project. Each open project folder can have its
own panel and session.

- **Pulsar Assistant: Open for this Project** — open or focus the panel for the
  project that owns the active editor file.

The project list is **not** stored in `config.cson`. A project has a panel when
that dock item is open. Pulsar restores the dock item with the workspace.

Command and test policy is a separate opt-in map you write yourself — see
[Project commands and tests](#project-commands-and-tests). It lives in user
config, not in the repo.

If several folders are open and no file is focused, open a file in the project
or right-click one in the tree view.

## Configure APIs and agents

Each entry in `agents` is one of two kinds. Put `type` on every agent so the
split is visible in `config.cson` and in the header picker:

| `type` | How it runs |
| --- | --- |
| `openai` | HTTP to an OpenAI-compatible `/chat/completions`. In-process. No ACP stdio. |
| `acp` | Spawn a local CLI (`command`) and speak Agent Client Protocol over real stdio. |

Legacy `type: "command"` is accepted and stored as `acp`.

### Example: OpenAI-compatible API

```cson
"pulsar-assistant":
  activeAgentId: "ours"
  agents:
    deepseek:
      apiKey: "YOUR_KEY"
      baseUrl: "https://api.deepseek.com"
      defaultModel: "deepseek-v4-pro"
      name: "DeepSeek"
      type: "openai"
    openai:
      apiKey: "YOUR_KEY"
      baseUrl: "https://api.openai.com/v1"
      defaultModel: "gpt-5.6-terra"
      name: "OpenAI"
      type: "openai"
    yandex:
      apiKey: "YOUR_KEY"
      baseUrl: "https://ai.api.cloud.yandex.net/v1"
      defaultModel: "gpt://b1gl8cdftb40gvn0nmtu/yandexgpt-5.1"
      name: "YandexGPT"
      type: "openai"
  projects:
    "/home/you/code/app":
      allowCommands: true
      testCommand: "npm test"
      maxTurnRequests: 20
  version: 1
```

`activeAgentId` is only the default for a *newly opened* panel. It is not a map
of projects. Each panel remembers its own selection on the dock item.

For `type: "openai"`, `defaultModel` is the default model for a newly opened
panel. The `model` field is read the same way. The optional `getModelsUrl`
overrides the standard `{baseUrl}/models` endpoint when a provider serves its
model list elsewhere. If the model list cannot be fetched, the panel asks you to
configure the exact model and continues with `defaultModel`.

Builtin tools: `read_file`, `write_file`, `grep`, `glob`, `list_dir`, `git`.
`run_command` and `run_tests` are off unless you opt in per folder (below).
`grep` is a JavaScript walk (works on Windows; no system grep). `git` is
always available without `allowCommands`, but only for a fixed allowlist of
subcommands; write operations ask for permission.

Image attachments are not supported and are not planned.

### Project commands and tests

Arbitrary commands and tests are **off** by default. This client has no ACP
terminal. To allow process execution for one folder, add that folder to
`pulsar-assistant.projects` in Pulsar **user** config (`Edit Agents` /
`config.cson`). Do not put this in the project directory — a malicious agent
could rewrite a file in the repo.

```cson
"pulsar-assistant":
  projects:
    "/absolute/path/to/the/project":
      allowCommands: true        # optional; omit or false = no run_command
      testCommand: "npm test"    # optional; omit = no run_tests
      maxTurnRequests: 20        # optional; maximum tool calls in one turn
```

`allowCommands` is a boolean. `testCommand` is the exact command line
(`run_tests` cannot change it). `maxTurnRequests` is a positive integer
overriding the default maximum number of tool calls in one turn. Keys are
absolute project roots. The **Tool turns** input in the panel edits
`maxTurnRequests` for the current project.

Spawned ACP CLIs still run as their own process and can execute commands without
going through this package. Use the builtin API agent if you want these
guards.

### Example: Copilot CLI

Install Copilot CLI and authenticate once:

```sh
copilot login
```

Defaults:

- A **GitHub Copilot** agent (`copilot --acp --stdio`) is seeded the first time the
  package activates.
- send host context: enabled

### Selecting an agent and model

The picker in the header (top-left) groups **API** and **ACP** agents for
**this panel** and lets you switch or open **Edit configuration…**. Switching
stops the current agent and clears the conversation. See [Agent details](#agent-details)
for the connected agent's live runtime info.

For API agents, a model selector sits next to the agent picker. It lists the
models reported by the provider's `/models` endpoint and keeps the selected
model on the dock item for this panel. Choosing a model restarts the agent with
that model.

![Agent picker menu in the panel header](docs/images/agent-picker.png)

The `agents` map in `config.cson` is the global registry — names, URLs, models,
keys, spawn commands — not which folders you opened. API entries use `baseUrl`
and `defaultModel`. ACP entries use `command` (full command line over stdio).
`npx @google/gemini-cli --experimental-acp` works without a global install.

Run **Pulsar Assistant: Edit Agents** (also in the picker and the Packages menu)
to open the config file. Changes apply on the next Restart or Switch.

If Pulsar cannot find the executable, set its full absolute path in `command`.
On Linux this may be something like:

```text
/home/you/.local/bin/copilot --acp --stdio
```

Wrap a path that contains spaces in double quotes, e.g.
`"C:\Program Files\agent\agent.exe" --acp --stdio`.

By default, Pulsar Assistant also sends a short host-context hint once per
session so a spawned ACP agent knows the conversation is happening through Pulsar, while also making clear that the agent cannot directly control Pulsar's UI.
Disable **Send host context** in package settings if you do not want this extra context included in prompts. API agents get the same idea from their system prompt instead.

## Develop

```sh
git clone https://github.com/Psychosynthesis/PulsarAssistan.git
cd pulsar-assistant
npm install
ppm link          # symlink the checkout into Pulsar
npm run typecheck
npm run build
npm run watch
```

Pulsar loads `lib/main.js`. Rebuild after editing `src/`, then reload Pulsar.

## Architecture

- `src/main.ts` registers commands, opener, dock item, deserializer, and
  status-bar service consumer. It never stores project paths in `config.cson`.
- `src/view/` renders the panel UI (`PulsarAssistantView` plus split helpers).
- `src/session/agent-session.ts` is the ACP client: in-process builtin agent or
  a spawned CLI, with cwd injected by the view.
- `src/builtin/` is the OpenAI-compatible ACP agent (tools + HTTP client).
- `src/agent-config.ts` holds the pure API/agent-registry logic.
- `src/project-policy.ts` reads `pulsar-assistant.projects` (user config only).
- `src/util.ts`, `src/grep.ts`, `src/project-uri.ts`, `src/openai-client.ts`
  are pure helpers, bundled separately for unit tests.

The SDK is ESM-only, so esbuild bundles it and `zod` into `lib/main.js`.

## Testing

`npm test` runs Node's built-in runner over `test/*.test.mjs`. Run
`npm run build` first because tests import the built bundles (`lib/util.js`,
`lib/agent-config.js`, `lib/grep.js`, …), not `src/`.

## Supported ACP features

| Feature | Status |
| --- | --- |
| `fs/read_text_file` / `fs/write_text_file` | yes, restricted to the session working directory |
| `session/request_permission` | yes |
| `terminal` | no; this client does not expose `terminal/*` |
| `authenticate` | yes, on demand when the agent reports it's required; prompts to choose when the agent offers multiple sign-in methods |

Beyond ACP, this package also adds:

| Feature | Status |
| --- | --- |
| host context hint | yes, sent once per session by default |

## Security

The builtin OpenAI-compatible agent runs in the Pulsar process. Spawned ACP
CLIs still run as a separate command-line process with your user account.
Pulsar does not sandbox either path.

The limits below only constrain tool and ACP requests that go through this
package. They do not restrict what a spawned agent does in its own process:

- `read_file` / `fs/read_text_file` and `write_file` / `fs/write_text_file` are
  served only when the target path resolves inside that panel's project folder.
- Builtin `grep`, `glob`, and `list_dir` walk that same folder and refuse paths
  that resolve outside it.
- Writes to open files with unsaved changes are refused.
- There is no ACP terminal. Builtin `run_command` runs only when
  `allowCommands` is true for that folder in Pulsar user config (outside the
  repo). `run_tests` runs only the configured `testCommand`. Both use
  `cross-spawn` without a shell. Stop cancels the turn.
- Builtin `git` runs in the project root without a shell and does not require
  `allowCommands`. It allows only status, diff, log, show, branch, blame,
  rev-parse, ls-files, checkout, switch, add, and commit. Checkout, switch, add,
  commit, and mutating branch operations (create, rename, delete) ask for
  permission; push/pull/fetch, reset/rebase, and force branch operations are
  rejected.
- `maxTurnRequests` limits the number of tool calls in one turn when set in
  `pulsar-assistant.projects`.

These are guard rails for a cooperating builtin agent, not a security boundary
for spawned CLIs. A spawned ACP agent can still run commands in its own process.
Use Pulsar Assistant only with APIs and spawned agents you trust; for stronger
isolation, run it inside a container or VM.
