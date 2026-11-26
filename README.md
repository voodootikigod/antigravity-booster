# antigravity-booster

Make Google Antigravity 2.0 (`agy` CLI + GUI) effective for large parallel
build-outs. Implements the Agentic Development Lifecycle
([ADLC](https://github.com/voodootikigod/adlc/blob/main/ADLC.md)) on Antigravity:
deterministic orchestration, quota-pool-aware scheduling, cross-model
prosecution, and gate-shaped validation for accurate ideation to merge.

Control flow is code, judgment is models: a deterministic Node scheduler
shapes specs via `/agb-shape` (`agb shape`) and the 5-lens Plan Adversarial
Review Loop, compiles ticket DAGs via the 0-LLM Structured Spec Fast-Path
(`agb plan`), dispatches `agy` workers into isolated git worktrees (`agb run`),
routes tiers across independent quota pools, prosecutes every diff with a
different model (`agb review` / `/code-review`), and merges only what passes
your build and test gates.

## Install

Requires `agy` >= 1.5.17 and Node >= 22.19.0.

Install from the **Antigravity Plugin Marketplace** (`Customizations > Marketplace` in the desktop app, `/plugin` Discover tab in the CLI, or `agy plugin install antigravity-booster@antigravity-plugins-official`), or directly from git:

```sh
agy plugin install https://github.com/voodootikigod/antigravity-booster.git
/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap
agb doctor
```

Bootstrap writes the `agb` command to `~/.local/bin/agb`; put that directory on
your `PATH` before running `agb doctor`.

## Documentation

Everything else (quickstart, concepts, guides, the full CLI and environment
reference, internals) lives on the docs site:
**<https://www.agybooster.com/docs>**.

- [Installation](https://www.agybooster.com/docs/getting-started/installation)
- [Quickstart](https://www.agybooster.com/docs/getting-started/quickstart)
- [CLI reference](https://www.agybooster.com/docs/reference/cli)
- [Benchmarks & Statistical Evals](https://www.agybooster.com/docs/reference/benchmarks)
- [Security model](https://www.agybooster.com/docs/reference/security)

Working *on* this repo? Read [AGENTS.md](AGENTS.md) first: the ADLC is
mandatory here.

## agb migrate

Moving from an npm-global or checkout install? See [Upgrading from npm](https://www.agybooster.com/docs/getting-started/upgrading-from-npm).

## Stability

Versioned with [semver](https://semver.org) since 1.0.0: **breaking changes
only in a major version**. The CLI surface, the `plan.json` schema and the
`.booster/` artifact layout hold still within a major (`^1.0.0`). Breaking
changes are called out in [CHANGELOG.md](CHANGELOG.md).

Only the latest published version receives fixes, including security fixes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm test` before opening a PR.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md);
please do not open a public issue for a vulnerability.
