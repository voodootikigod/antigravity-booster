# Just-in-time ticket drafts

Reviewed, coldstart-audited drafts for T2–T4 of `.adlc/specs/native-plugin-installation.md`.
They are **not** in the ticket store yet. The in-session rails hook unions rails across every
active ticket, so writing them early would freeze `bin/hook-runner.sh`, `bin/node-launcher.sh`
and `lib/adlc-bridge.mjs` while T1 is still creating those files (owner decision, 2026-10-04).

When a predecessor ticket merges and is completed/archived, write the next draft:

    adlc ticket create --input .adlc/specs/native-plugin-installation.tickets/<ID>.json --write
    adlc coldstart <ID> --prompt-only   # answer, then --record-verdict

Drafts carry their forward edge (`edges: [{ "to": <next> }]`). Strip it before writing if the
dependent ticket does not exist yet. Delete each draft once it has been written to the store.
