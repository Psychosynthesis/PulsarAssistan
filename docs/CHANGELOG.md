# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] - 2026-09-12
- **Unified Ignored Directories & Package Configuration**: Consolidated conflicting ignore directory lists from `grep.ts` and `file-btree.ts` into a single module `src/ignored-dirs.ts` (`DEFAULT_IGNORED_DIRS`). Added `ignoredDirectories` configuration option in `package.json` (`configSchema`) so users can customize ignored directories through Pulsar's Settings view.
- **Configurable Tool Call Delay (TPM / 429 Protection)**: Introduced per-project configurable delay between tool calls (`toolCallDelayMs`, defaults to 500ms, minimum 100ms) with a dedicated "Delay (ms)" control in the panel actions bar. Prevents rapid-fire API completions from hitting rate limits (HTTP 429).
- **Smart Context Compaction**: `compactContext` now preserves the full output of the most recent tool batch while summarizing older history, ensuring the model retains immediate access to freshly read files without repeatedly running the same tool calls.
- **Detailed API Error Messages**: OpenAi client parses response bodies on HTTP errors (e.g. JSON `error.message` or plain text error excerpts) instead of displaying a generic "API error 429", giving full visibility into rate limits, token limits, and retry recommendations directly in the chat.
- **View Decomposition & Architecture Refactoring**: Split monolithic `AgentView` (reduced from 3865 to ~1550 lines) into modular components under `src/view/components/`:
  - `ComposerStatusBar`: Status/thoughts/compaction notifications above the composer input.
  - `PlanBarView`: Agent task plan bar, checklist, and snapshotting.
  - `ToolCallManager`: Collapsible tool executions, diffs, line counters.
  - `PermissionManager`: Permissions review cards and authentication picker.
- **Model Reasoning & Live Status Bar**: Added real-time extraction of `reasoning_content` and `thought` from OpenAI-compatible SSE and non-streaming responses. Displayed above composer in a sleek, non-intrusive slate-blue status line (`ComposerStatusBar`).
- **Immediate Context Progress Updates**: Token context progress bar now updates immediately after each tool execution step, reflecting real-time context growth without waiting for the full turn to finish.
- **Fixed Working Indicator & Button Locking**:
  - Emitting proper `turn-start` and `turn-end` events in `AgentSession.prompt()`.
  - Fixed Send & Stop buttons remaining locked after agent finishes responding.
  - Fixed "Working..." status hanging indefinitely.
- **In-Panel Compaction Feedback**: Context compaction notifications now render directly in the composer status bar instead of popping up intrusive Pulsar system notifications.


## [0.5.0] - 2026-09-11

- **Context Capacity & Progress Bar**: Real-time token context usage bar in the panel header next to the model picker for OpenAI-compatible agents. Estimates tokens for chat history, tool calls, results, and active draft input using an offline weighted heuristic (~3.7 chars/token for ASCII, ~1.5 chars/token for Cyrillic/Unicode). Resolves context limits from user config (`pulsar-assistant.modelContextWindows`), API `/models` metadata, or built-in model defaults (Gemini 1M, Claude 200k, GPT-4o/DeepSeek/Qwen 128k, etc.) with color-coded warning thresholds.
- **Projects & Context Storage Management Modal**: Accessible via `pulsar-assistant:manage-projects`, command palette, Packages menu, or the agent dropdown menu ("Manage projects & storage…"). Displays disk usage, session counts, and B-tree index status per project with safe deletion confirmation, along with a table of active model context window limits.
- **Conversation Context Compaction**: Added a compact context button (`icon-fold`) in the panel header. Replaces completed tool outputs (e.g. large file contents, directory listings, command logs) with compact historical summaries, immediately freeing up model context window capacity.
- **Increased Tool Turns Limits**: Raised the default tool turns limit from 20 to 200 iterations for built-in OpenAI-compatible agents, and raised the maximum allowed value from 100 to 1000 in both UI input validation and execution loop clamping.
- **Modular Driver/Backend Architecture**: Refactored `AgentSession` using the Driver/Backend pattern. Protocol operations are decoupled into `AcpCliBackend` (stdio ACP) and `BuiltinBackend` (in-process OpenAI-compatible agent). Editor integrations are encapsulated in `EditorBackend`, and B-Tree project structure management is isolated in `ProjectFileTreeManager`.
- **Seamless On-the-Fly Model Switching**: Changing the model in the panel header for OpenAI-compatible agents switches the model dynamically for subsequent prompts without restarting the agent or clearing chat history.
- **Persistent Session and Context Storage**: Sessions, complete conversation histories, tool calls, and metadata are saved to disk under `${configDir}/storage/pulsar-assistant/projects/${projectName}-${projectHash}/sessions/`. Supports loading previous sessions, replaying messages to the UI, and session deletion.
- **B-Tree Project File Structure Tracking**: File hierarchy is maintained in a balanced B-tree (`BTree`, `ProjectFileTree`) with automatic exclusion of junk directories (`node_modules`, `.git`, `dist`, `.venv`, etc.). Persisted to `tree.json` with debounced batch updates upon editor and filesystem changes, providing fast file tree context to builtin agents.
- **Improved Composer Layout**: Increased composer textarea minimum height to 150px for comfortable multi-line prompt editing.

## [0.4.0] - 2026-09-10

- The header **More** row shows a compact per-session API traffic summary for
  OpenAI-compatible agents: request count plus sent and received bytes.
- The **Tool turns** input no longer shows native number spinners and is wider.
  It now sits in the right side of the actions row together with the
  **Permissions** toggle.
- Grep tool results are compacted after the model has seen them once, so
  follow-up OpenAI-compatible API calls no longer resend the full result.

## [0.3.0] - 2026-09-10

- API agents (`type: openai`) can list available models from the provider's
  `/models` endpoint and switch the panel model from the header selector.
- `model` is read as `defaultModel`; the new canonical name is `defaultModel`.
- Optional `getModelsUrl` overrides `{baseUrl}/models` for providers that use a
  different listing endpoint.
- When the model list is unavailable, the agent status warns and the panel keeps
  using the configured exact model.
- Model descriptions from the listing are shown in the **More** panel.
- Permission prompts gain **Allow for this session**, scoped to the current
  conversation.
- Tool output collapses to a short summary for large text output and diffs
  longer than 20 lines.
- Added a per-project **Tool turns** input to override the default
  `max_turn_requests` limit.
- Builtin `git` tool is always on (no `allowCommands`): status, diff, log,
  show, branch, blame, rev-parse, ls-files, checkout, switch, add, commit.
  Mutating operations ask for permission; push/pull/fetch, reset/rebase, and
  force branch operations are rejected.
- README.md examples added.

## [0.2.0] - 2026-09-10

- API agents (`type: openai`) are called in-process. Only spawned CLIs
  (`type: acp`) use ACP stdio. There is no fake in-process ACP pipe.
- Agent config and the header picker split **API** and **ACP**. Legacy
