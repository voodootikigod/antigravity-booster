# agy CLI Research

## Conversation IDs in --print mode

When running `agy --print`, the conversation ID is NOT obtainable via a robust programmatic method. The command exits successfully with no output to stderr, and no resume-command line is printed. Since scanning ~/.gemini state is race-prone and does not qualify as obtainable, this finding means we cannot link JSONL transcripts back to specific `runAgy` calls robustly at runtime.

