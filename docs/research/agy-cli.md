# agy CLI Research

## Conversation IDs in --print mode

In `agy 1.2.8+` (and `1.3.5`), `conversation_id` is programmatically emitted:
- In `--output-format json`: emitted in the top-level response envelope (`parsed.conversation_id`).
- In `--output-format stream-json`: emitted in event objects (`ev.conversation_id`, `ev.step_update?.conversation_id`, `ev.result?.conversation_id`, or `ev.init?.conversation_id`).

Furthermore, `agy` accepts `--conversation <id>` (alias `-c`) to resume an existing conversation. This allows booster to execute warm second-strike builder retries without repeating dead ends in fresh sessions.

## Project Isolation (--project vs --new-project)

- `--new-project`: Creates a new project on every single invocation. In headless environments (like `agb`), this would spam the user's workspace with a new project for every single model dispatch, which is undesirable.
- `--project <name-or-id>`: Accepts a project name or ID. If a project with the given name doesn't exist, it is automatically created on the first invocation. Subsequent invocations with the same name will reuse the project. This makes it ideal for per-run isolation (e.g., `--project agb-run-12345`).

## ISSUE-25 Resolution: Conversation ID in --print mode

- **CLI Protocol:** In `agy 1.2.8+`, headless runs via `--print` provide structured envelopes when `--output-format json` or `--output-format stream-json` is specified.
- **Conversation ID extraction:** Booster extracts `conversation_id` from the response envelopes / stream events and preserves it across strikes.
- **Resumption:** Second strikes reuse the conversation ID by appending `--conversation <id>` when rerunning on the same model.
