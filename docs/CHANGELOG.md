# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-10

- Builtin `git` tool is always on (no `allowCommands`): status, diff, log,
  branch, checkout, switch, add, commit. Not push/reset/rebase.
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
