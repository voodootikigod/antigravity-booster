# Contributing

Thanks for considering a contribution. This repo runs its own doctrine on itself,
so a few of the rules below are enforced by CI rather than by convention.

## Getting set up

```sh
git clone https://github.com/voodootikigod/antigravity-booster.git
cd antigravity-booster
npm ci
npm test          # fully offline: fake-agy + fake-adlc fixtures, no API keys
```

`npm test` needs no credentials and reaches no network. If a change makes the
suite require either, that is a bug in the change.

To exercise the real CLI you also need Google Antigravity's `agy` on `PATH` and
the ADLC toolkit (`npm i -g @adlc/cli`). `agb doctor` reports what is missing.

## The bar for a change

**Tests must be load-bearing.** A passing suite is not evidence; a suite that
fails when you break the code is. Before submitting, delete the guard your test
covers and confirm your test goes red. If it stays green, the test is decorative
and will be treated as such in review. `adlc hollow-test` automates this.

**Fix the code, not the test.** If a test fails, the default assumption is that
the test is right.

**Match the surrounding code.** No new dependencies without a reason that
survives the question "what does this do that Node cannot?" — the package ships
with two, both first-party.

## Things CI will reject

- **Frozen rails.** Paths declared as `rails` in `.adlc/tickets.json` cannot be
  edited by a PR. This is enforced in-session by a hook and at merge by
  `.github/workflows/adlc-rails-guard.yml`. If your change genuinely needs to
  touch one, it needs its own ticket — not a bypass.
- **Removing or rewriting base tickets.** `.adlc/tickets.json` is append-only in a
  PR; existing tickets must survive byte-identically.
- **A drifted lockfile.** CI runs `npm ci`, so `package-lock.json` must agree with
  `package.json`.
- **Undocumented commands.** Every dispatched command needs a row in the
  `COMMANDS` table in `bin/agb.mjs`; a test enforces it.

## Platform notes

Gate sandboxing uses `sandbox-exec` and is macOS-only, so several security tests
skip on Linux. CI runs a macOS leg specifically to exercise them — if you touch
`lib/gates.mjs`, watch that leg, not just the Linux one.

## Commits and PRs

Conventional commit prefixes (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`).
Explain *why* in the body; the diff already shows what. Keep unrelated changes in
separate commits.

`main` requires review, so open a PR rather than pushing to it.

## Reporting security issues

Do not open a public issue — see [SECURITY.md](SECURITY.md).
