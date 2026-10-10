# agy CLI Research

## Conversation IDs in --print mode

When running `agy --print`, the conversation ID is NOT obtainable via a robust programmatic method. The command exits successfully with no output to stderr, and no resume-command line is printed. Since scanning ~/.gemini state is race-prone and does not qualify as obtainable, this finding means we cannot link JSONL transcripts back to specific `runAgy` calls robustly at runtime.


## Project Isolation (--project vs --new-project)

- `--new-project`: Creates a new project on every single invocation. In headless environments (like `agb`), this would spam the user's workspace with a new project for every single model dispatch, which is undesirable.
- `--project <name-or-id>`: Accepts a project name or ID. If a project with the given name doesn't exist, it is automatically created on the first invocation. Subsequent invocations with the same name will reuse the project. This makes it ideal for per-run isolation (e.g., `--project agb-run-12345`).

## ISSUE-25 Probe: Conversation ID in --print mode

- **Stdout/Stderr:** In `agy --print` mode, standard output is strictly reserved for the LLM response, and standard error is empty. No resume command is printed on session exit (unlike interactive TTY mode).
- **State Files:** While conversation directories are created in `~/.gemini/antigravity-cli/brain/`, multiple `agy --print` invocations can run concurrently (e.g. parallel ticket build-outs). There is no reliable mechanism to map a specific headless run to a UUID without inherent race conditions, as `history.jsonl` does not consistently log headless runs with project isolation mapping.
- **Conclusion:** The conversation ID is not programmatically obtainable for `--print` mode in the current version of the CLI. This feature is **blocked-upstream** until `agy` exposes the conversation ID via stderr or an environment variable/metadata file.
