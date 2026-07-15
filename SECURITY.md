# Security Policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/voodootikigod/antigravity-booster/security/advisories/new).
Do not open a public issue for a vulnerability.

Include what you need to make the problem reproducible: the version (`agb --version`
or the `antigravity-booster` version in your lockfile), your OS, and the smallest
plan or command that triggers it. If you have a proof of concept, attach it.

Expect an acknowledgement within 7 days and an assessment within 14. If a fix is
warranted, we will agree a disclosure timeline with you before publishing.

## Supported versions

Only the latest published version receives security fixes. This project is pre-1.0
(see [Stability](README.md#stability)); there are no long-term support branches.

## Threat model

`agb` orchestrates an LLM CLI (`agy`) that writes code, runs your build and test
commands, and merges branches. Understanding what it does and does not defend
against matters more than a version number.

**What `agb` treats as untrusted:** everything the model produces. Model output is
never shell-interpolated (subprocesses are spawned with argument arrays, not
`shell: true`), the merge decision is made by a JSON severity contract rather than
the model's own verdict, and transcript output is stripped of terminal control
bytes before rendering.

**What `agb` treats as trusted:** your `plan.json`, including its `gate` commands.
Those are your build and test commands and they run on your machine by design.
`agb` executes what you configured; a plan you did not write deserves the same
scrutiny as a shell script you did not write.

**Boundaries you should know about:**

- **Gate sandboxing is macOS-only.** Gate commands can be rewritten by the builder
  inside its worktree, so they run under `sandbox-exec` (network denied; writes
  confined to the worktree, excluding `.git` and `node_modules`). `sandbox-exec`
  does not exist on Linux, so on Linux a requested sandbox **refuses to run**
  rather than silently executing unsandboxed. Set `AGB_SANDBOX_GATES=0` to proceed
  deliberately — only inside a disposable container.
- **Subprocesses inherit your environment.** `agy` and gate commands receive the
  full environment of the `agb` process. If your shell exports credentials
  (`NPM_TOKEN`, cloud keys), the model's process can read them. Run `agb` from a
  shell that does not export secrets you would not hand to the model.
- **Transcripts may contain secrets.** The model can quote files it reads —
  including a `.env` — into its output, which is recorded. Transcripts, run state,
  and reports under `.booster/` are written owner-only (`0600`), but they are
  plaintext on disk. Treat `.booster/` as sensitive; it is gitignored by default.
- **`AGB_ALLOW_DIRTY=1` permits a destructive rollback.** A failed gate can trigger
  `git reset --hard`, discarding uncommitted work. Off by default; the warning is
  not decorative.

## Scope

In scope: sandbox escapes, command injection reachable from model output or a
plan's non-gate fields, secrets written outside `0600` files, the merge gate being
bypassable, and CI/publish supply-chain weaknesses.

Out of scope: a gate command doing what you told it to do, and anything requiring
an attacker who already has write access to your repository or your machine.
