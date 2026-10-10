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

To exercise the real CLI you also need Google Antigravity's `agy` on `PATH`.
The ADLC toolkit comes in with `npm ci` (no global install); if it is missing,
`agb doctor` reports it with the fix text
[`npm install @adlc/cli` or `npx agb bootstrap`](https://github.com/voodootikigod/antigravity-booster/blob/v1.0.0/lib/doctor.mjs#L325).

## The bar for a change

**Tests must be load-bearing.** A passing suite is not evidence; a suite that
fails when you break the code is. Before submitting, delete the guard your test
covers and confirm your test goes red. If it stays green, the test is decorative
and will be treated as such in review. `adlc hollow-test` automates this.

**Fix the code, not the test.** If a test fails, the default assumption is that
the test is right.

**Match the surrounding code.** No new dependencies without a reason that
survives the question "what does this do that Node cannot?" — the package has
no runtime `dependencies`; every package is a
[devDependency](https://github.com/voodootikigod/antigravity-booster/blob/v1.0.0/package.json#L56) and the shipped plugin runs from
prebuilt bundles.

## Things CI will reject

- **Frozen rails.** Paths declared as `rails` in the `.adlc/tickets/` directory
  store cannot be edited by a PR. This is enforced in-session by a hook and at
  merge by `.github/workflows/adlc-rails-guard.yml`, which
  [reads the `.adlc/tickets/` store](https://github.com/voodootikigod/antigravity-booster/blob/a99b3cd/.github/workflows/adlc-rails-guard.yml#L13). If your change genuinely needs to
  touch one, it needs its own ticket — not a bypass.
- **Removing or rewriting base tickets.** Existing base tickets in the
  `.adlc/tickets/` store
  [are protected](https://github.com/voodootikigod/antigravity-booster/blob/a99b3cd/.github/workflows/adlc-rails-guard.yml#L55): a PR
  may add tickets, mark a base ticket completed, or archive it into
  `.adlc/ticket-archive/`; any other edit or removal is denied.
- **A drifted lockfile.** CI runs `npm ci`, so `package-lock.json` must agree with
  `package.json`.
- **Undocumented commands.** Every dispatched command needs a row in the
  `COMMANDS` table in `bin/agb.mjs`; a test enforces it.

## Committed bundles (`dist/`, `vendor/`)

The plugin ships prebuilt bundles so `agy plugin install <git-url>` works without `npm install`. They are generated, never hand-edited:

- After changing anything under `bin/`, `lib/`, `hooks/` or `mcp/`, run `npm run build` and commit `dist/` with the source change. CI rebuilds and fails on any drift.
- When a rebase or restack conflicts inside `dist/` or `vendor/`, do not resolve the conflict by hand. Resolve the *source* conflicts, then run `npm run build` and commit the regenerated output. The CI drift gate is the arbiter.
- `vendor/cache/adlc-antigravity-<version>.tgz` is the pristine npm tarball. CI re-downloads it and requires byte-identity; never edit or repack it.

## Do not bump the version in your PR

Leave `package.json`'s `version` alone. Releases are cut separately: a release PR
carries the bump and nothing else, and the tag goes up immediately after it
merges. The tag is what triggers publishing.

A bump inside a feature PR lands a new version on `main` with no tag behind it,
so nothing publishes and nothing complains — the release is stranded until
someone notices npm is behind. That is not hypothetical: 0.5.0 shipped a day
late for exactly this reason. `.github/workflows/release-drift.yml` now catches
it within a day, but the cheaper fix is not to do it.

## Platform notes

Gate sandboxing uses Seatbelt (`sandbox-exec`) on macOS and
[Bubblewrap (`bwrap`) on Linux](https://github.com/voodootikigod/antigravity-booster/blob/v1.0.0/lib/gates.mjs#L56-L84), with the
network [denied](https://github.com/voodootikigod/antigravity-booster/blob/v1.0.0/lib/gates.mjs#L49) and writes limited to the worktree
and temp. Gates fail closed only when no sandbox is usable. Windows has no gate
sandbox (use `AGB_SANDBOX_GATES=0`), and its builder containment check can only
be bypassed with an [HMAC-attested attestation](https://github.com/voodootikigod/antigravity-booster/blob/v1.0.0/lib/agy.mjs#L276-L285). Some sandbox tests are platform-specific, so CI runs a
macOS leg — if you touch `lib/gates.mjs`, watch every leg.

## Docs generator contract

The docs site's reference pages are generated from code. The shape of the
`COMMANDS` literal in `bin/agb.mjs` and the tool array in `mcp/server.mjs` is
parsed by the generators. If your code PR changes those shapes, or adds a
command, flag, env var, export or MCP tool, run `cd website && npm run gen` and
commit `website/generated/` in the same PR. CI fails on stale generated output.

## Commits and PRs

Conventional commit prefixes (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`).
Explain *why* in the body; the diff already shows what. Keep unrelated changes in
separate commits.

`main` requires review, so open a PR rather than pushing to it.

## Reporting security issues

Do not open a public issue — see [SECURITY.md](SECURITY.md).
