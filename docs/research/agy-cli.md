# agy CLI Research

## Conversation IDs in --print mode

When running `agy --print`, the conversation ID is NOT obtainable via a robust programmatic method. The command exits successfully with no output to stderr, and no resume-command line is printed. Since scanning ~/.gemini state is race-prone and does not qualify as obtainable, this finding means we cannot link JSONL transcripts back to specific `runAgy` calls robustly at runtime.


## Project Isolation (--project vs --new-project)

- `--new-project`: Creates a new project on every single invocation. In headless environments (like `agb`), this would spam the user's workspace with a new project for every single model dispatch, which is undesirable.
- `--project <name-or-id>`: Accepts a project name or ID. If a project with the given name doesn't exist, it is automatically created on the first invocation. Subsequent invocations with the same name will reuse the project. This makes it ideal for per-run isolation (e.g., `--project agb-run-12345`).
