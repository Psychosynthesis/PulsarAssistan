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
- Seamless on-the-fly model switching for OpenAI-compatible agents without resetting context or clearing chat history.
- Real-time token context usage indicator and capacity progress bar with color-coded warning thresholds.
- Compact conversation context action to reclaim model window capacity by summarizing completed tool outputs.
- Dedicated Projects & Storage management modal to review and delete cached sessions, disk usage, and B-tree indexes.
- Persistent session storage on disk with message history, tool execution results, and metadata.
- Balanced B-tree file indexing (`tree.json`) with debounced updates for instant project hierarchy context.
- Attach the current file or selection to prompts.
- Review permission prompts, tool output, diffs, plans, and session history inline.
- Configure and switch between APIs from the panel header.
- Track OpenAI-compatible API traffic per session in the panel header: request count plus bytes sent and received.

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
  - [Model context window and token usage](#model-context-window-and-token-usage)
  - [Compacting conversation context](#compacting-conversation-context)
  - [Managing projects & storage](#managing-projects--storage)
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

## Configure APIs and agents

Open your Pulsar configuration file:

- Command palette: **Application: Open Your Config**
- Or run **Pulsar Assistant: Edit Agents**

Pulsar Assistant stores agents under `pulsar-assistant.agents`:

```cson
"*":
  "pulsar-assistant":
    agents:
      openai:
        type: "openai"
        name: "OpenAI API"
        baseUrl: "https://api.openai.com/v1"
        apiKey: "YOUR_OPENAI_API_KEY"
        defaultModel: "gpt-4o"
      openrouter:
        type: "openai"
        name: "OpenRouter"
        baseUrl: "https://openrouter.ai/api/v1"
        apiKey: "YOUR_OPENROUTER_KEY"
        defaultModel: "anthropic/claude-3.5-sonnet"
```

### Example: OpenAI-compatible API

The builtin agent implements the tool loop locally and sends standard OpenAI
chat completion requests with tool definitions. Any provider that supports
tool calling works out of the box:

- OpenAI
- OpenRouter
- DeepSeek
- Groq
- Ollama / LM Studio / LocalAI / vLLM

Required fields:

- `type`: `"openai"`
- `name`: display name in the picker
- `baseUrl`: base URL without trailing slash (e.g. `https://api.openai.com/v1`)
- `apiKey`: your secret key (can be any string or empty for local engines)
- `defaultModel`: model identifier to use on initial panel open

Optional fields:

- `modelsUrl`: override endpoint for fetching models (defaults to `{baseUrl}/models`)
- `systemPrompt`: custom system instructions prepended to every conversation turn

### Project commands and tests

By default, the builtin agent has no terminal access. To allow `run_command` or
`run_tests` for a specific project, declare policies in `config.cson`:

```cson
"*":
  "pulsar-assistant":
    projects:
      "/path/to/my/project":
        allowCommands: true      # enables run_command
        testCommand: "npm test"  # exact test command run by run_tests
        maxTurnRequests: 200     # optional; maximum tool calls in one turn (default: 200, max: 1000)
```

`allowCommands` is a boolean. `testCommand` is the exact command line
(`run_tests` cannot change it). `maxTurnRequests` is a positive integer
(up to 1000) overriding the default maximum number of tool calls in one turn (200).
Keys are absolute project roots. The **Tool turns** input in the panel edits
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
model on the dock item for this panel. Choosing a different model switches the model
dynamically on the fly for subsequent requests without resetting the session or clearing conversation history.

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

### Model context window and token usage

For OpenAI-compatible agents, the header displays a live token usage progress bar right next to the model selector. It calculates the cumulative token count of the system prompt, conversation history, tool calls, and your uncommitted draft input using an offline weighted heuristic (~3.7 chars/token for ASCII code, ~1.5 chars/token for Cyrillic/Unicode).

Context limits are resolved in order of priority:
1. Custom overrides from `pulsar-assistant.modelContextWindows` in `config.cson`.
2. Metadata returned by the provider's `/models` endpoint (e.g. `context_length`).
3. Built-in defaults for known families (Gemini: 1M, Claude: 200k, GPT-4o / DeepSeek / Qwen: 128k, etc.).
4. Fallback: 128k tokens.

The bar turns yellow above 70% and red above 90%.

### Compacting conversation context

To save tokens on long multi-turn conversations, click the **Compact conversation context** button (`icon-fold`) in the header right controls. This replaces bulky historical outputs from previous tool invocations (`read_file`, `list_dir`, `find_files`, `get_file_structure`, `git`, `write_file`, etc.) with compact summaries, immediately reducing context window consumption for follow-up prompts.

### Managing projects & storage

Open the modal via **Packages → Pulsar Assistant → Manage Projects & Storage**, through the command palette (`pulsar-assistant:manage-projects`), or from the agent dropdown menu ("Manage projects & storage…").

The modal allows you to:
- Review and verify effective model context limits.
- Inspect cached sessions, disk size, and B-tree file indexes per project.
- Delete project history and cached data from disk with confirmation.

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
- `src/view/context-progress-bar.ts` renders the real-time context capacity bar and tooltips.
- `src/view/projects-storage-modal.ts` implements the projects and disk storage management dialog.
- `src/editor/` provides the `EditorBackend` abstraction (`PulsarEditorBackend`) isolating editor buffers, containment checks, and file watchers from the rest of the application.
- `src/session/agent-session.ts` is the unified facade managing session lifecycle and routing calls to drivers.
- `src/session/backends/` implements agent drivers (`AgentBackend`):
  - `BuiltinBackend`: in-process OpenAI-compatible HTTP agent.
  - `AcpCliBackend`: spawned ACP CLI processes communicating over JSON-RPC stdio.
- `src/session/file-tree-manager.ts` coordinates B-tree project file indexing, debouncing, and disk persistence (`tree.json`).
- `src/builtin/` is the OpenAI-compatible ACP agent (tools + HTTP client).
- `src/session-storage.ts` manages disk persistence for project sessions and message histories under `${configDir}/storage/pulsar-assistant/projects/${projectName}-${projectHash}/`.
- `src/file-btree.ts` provides balanced B-Tree (`BTree`, `ProjectFileTree`) project file indexing with debounced disk persistence (`tree.json`) and compressed hierarchy context for models.
- `src/token-estimate.ts` computes fast weighted token estimates and resolves model context limits.
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
| OpenAI-compatible API traffic summary | yes, per panel session |

## Security

The builtin OpenAI-compatible agent runs in the Pulsar process. Spawned ACP
CLIs still run as a separate command-line process with your user account.
