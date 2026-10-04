# Native Antigravity Plugin Installation — Spec Pointer

The canonical, normative specification lives at
[`.adlc/specs/native-plugin-installation.md`](../../.adlc/specs/native-plugin-installation.md).

This file is intentionally a pointer: keeping a single copy prevents the two from drifting.
The canonical spec ends with **Appendix A — Errata, Resolved Decisions & Linux Verification**,
which is normative and overrides earlier sections where they conflict.

- Live platform probe evidence (agy 1.2.16, Linux) and the reproducible probe script:
  [`.adlc/specs/native-plugin-installation.evidence/`](../../.adlc/specs/native-plugin-installation.evidence/)
- Implementation is decomposed into four ADLC tickets in `.adlc/tickets/`:
  `T-PLUGIN-01-CORE` → `T-PLUGIN-02-ADLC-BRIDGE` → `T-PLUGIN-03-DOCTOR-HANDSHAKE` → `T-PLUGIN-04-MIGRATE-ROLLBACK-DOCS`.
