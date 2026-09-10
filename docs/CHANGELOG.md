# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- README examples added.

## [0.2.0] - 2026-09-10

- API agents (`type: openai`) are called in-process. Only spawned CLIs
  (`type: acp`) use ACP stdio. There is no fake in-process ACP pipe.
- Agent config and the header picker split **API** and **ACP**. Legacy
  `type: command` is stored as `acp`.
- Tree-view right-click **Open for this Project**.
- Dock tab title is **Pulsar Assistant | project**.
- Startup timeout for spawned ACP CLIs names the agent and includes recent
  stderr.

## [0.1.0] - 2026-09-10

Initial version of `pulsar-assistant`.

- Image attachments (picker, paste, drag-and-drop) - not planned.
- The header picker selects an API (or spawn fallback) for the current panel.
- `activeAgentId` is only the default for a newly opened panel.
- One panel per project folder. Open with **Open for this Project**; ACP stays
  off until then. Open panels are not written to `config.cson`.
- Builtin OpenAI-compatible agent (`type: openai`) with `read_file`,
  `write_file`, `grep`, `glob`, `list_dir`, plus opt-in `run_command` and
  `run_tests`. Spawned ACP CLIs remain as a fallback.
- No ACP `terminal/*`. This client does not run a shell for agents.
- `run_command` requires `allowCommands: true` for that folder in Pulsar user
  config (`pulsar-assistant.projects`). `run_tests` runs the exact `testCommand`
  from the same map. Neither setting is stored in the project tree.
