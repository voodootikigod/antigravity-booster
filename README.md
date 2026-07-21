# antigravity-booster

Make Google Antigravity 2.0 (`agy` CLI + GUI) effective for large parallel
build-outs. Implements the Agentic Development Lifecycle
([ADLC](https://github.com/voodootikigod/adlc/blob/main/ADLC.md)) on Antigravity:
deterministic orchestration, quota-pool-aware scheduling, cross-model
prosecution, and gate-shaped validation for accurate ideation to merge.

## Documentation

Full guides, specifications, and walkthroughs are available:
- 🤖 **[AGENTS.md](AGENTS.md)** — required reading for any agent (or human) working *on* this repo: the ADLC is mandatory here, not optional.
- 🚀 **[CLI Usage & Configuration](docs/usage.md)**
- 🛡️ **[Guidelines & Doctrine](docs/guidelines.md)**
- 📖 **[Concrete Execution Walkthrough](docs/execution-example.md)** — A complete, step-by-step example showing how to decompose a specification (like `do-better`) into a `plan.json` DAG and run it with `agb`.
- 📊 **[Calibration Probes](docs/calibration/probes-2026-06-11.md)**

## Why

Antigravity gives generous (not infinite — see
[docs/research/antigravity-gui.md](docs/research/antigravity-gui.md)) model
quota across **independent per-model pools**, but it is slow to parallelize
by hand and burns quota fast when unsupervised. Booster turns it into a
disciplined fleet:

- **Control flow is code, judgment is models.** A zero-dependency Node
  scheduler dispatches `agy --print` workers; no model ever decides
  sequencing.
- **Quota pools as a concurrency multiplier.** Gemini Flash, Gemini Pro,
  and Claude pools throttle and meter independently (verified by probe) —
  the scheduler holds a semaphore per pool and routes tiers across them.
- **Cross-model prosecution.** Gemini-built diffs are prosecuted by Claude
  and vice versa, with a refute charter and a JSON verdict contract, backed
  by `adlc hollow-test` mutation evidence the model's own verdict can't
  overrule. Critical/high findings block the merge.
- **Deterministic gates.** Build/test commands gate every ticket in its
  worktree and again post-merge on main (failed post-merge gate = revert).
- **Two-strike regeneration, informed by `adlc flail-detector`.** A flailing
  worker is never coached — but "flailing" is a diagnosed signal (repeated
  errors, scope violations, edit churn, oversized logs), not a bare failure
  count. A genuine flail pattern skips the second strike; a clean one-off
  failure still gets its normal retry with dead-ends appended.
- **Consensus-fix over single-shot regeneration.** A blocked prosecution
  fans out candidate fixes via `adlc consensus-fix` and applies the first
  gated winner before falling back to a single-attempt fix round.
- **Self-hosted ADLC gates.** This repo dogfoods the same doctrine it
  imposes on target repos: `.adlc/tickets.json` is the tracked ticket
  contract, `.adlc/config.json` is the bootstrapped trust root, and
  `.github/workflows/adlc-rails-guard.yml` enforces frozen rails in CI, not
  just locally. See [AGENTS.md](AGENTS.md).

## 🚀 Installation & Setup

Before starting, ensure you have **Node >= 18**, the **Antigravity CLI (`agy`)** installed and authenticated on your `PATH`, and a clean target git repository. 

*(Note: Gates use macOS Seatbelt by default. On Linux/Windows, run inside a disposable container and set `AGB_SANDBOX_GATES=0`.)*

We recommend installing `agb` globally. Since it is now a native Antigravity Plugin, you must then install it into `agy` to automatically wire up the Sidecar dashboard and ADLC skills:

```sh
npm install -g antigravity-booster
agy plugin install antigravity-booster
```
*(Alternatively, use `agb bootstrap` if developing from a local source checkout.)*

### 2. Verify Setup
Run the diagnostic tool to ensure your dependencies and quota are ready:
```sh
agb doctor
```
*(Optional: `export ADLC_PROVIDER=agy` to route general `@adlc` tools through Antigravity).*

## Quickstart
**Plan in Antigravity, execute with agb.** Planning stays exactly where it
already works: Antigravity's plan phase — the desktop app's plan mode or a
planning conversation in an `agy` session. Both write the same brain
artifact (`implementation_plan.md` under `~/.gemini/antigravity/brain/`).
`agb` does **not** replace or supplement that phase; it consumes the
artifact it produces. Think of `implementation_plan.md` as source and
`plan.json` as a compiled artifact — `agb plan` is the compiler.

1. Compile a plan (from either a local raw Markdown spec file path, OR a GUI plan/agy conversation brain ID) into an executable ticket DAG:

   ```sh
   # Option A: Compile from a local markdown spec file path:
   agb plan spec.md /abs/repo

   # Option B: Compile from a GUI plan / agy session brain ID:
   agb brains                       # list plan artifacts, newest first
   agb plan <brain-id> /abs/repo    # compile → gate → plan.json; exit 0/2
   ```

   The compiler converts the plan with a frontier model, then loops it
   through plan gates, feeding every failure back into a re-conversion
   instead of dumping invalid JSON on you:

   - **structural** (free, deterministic): schema, DAG cycles, tier/pool
     routability, scope-overlap forecast between parallel tickets;
   - **coldstart** (cheap tier): each ticket must be executable by a fresh
     agent from its body alone;
   - **parallax** (ADLC D3, cheap tier): per DAG edge, N fresh contexts
     independently author the implied contract — measured divergence is
     contract ambiguity and blocks the compile;
   - **premortem** (ADLC C2, frontier, advisory): "this run failed three
     months ago — write the postmortem"; risks are reported, never veto.

    Findings that survive the feedback loop are reported with the
    remediation pointing at the *plan* (refine the plan in Antigravity or edit your local raw spec file, and re-run `agb plan`). The compiled `plan.json` carries a `source` provenance stamp
    naming the brain conversation or spec file it came from. Flags: `--out <file>`,
    `--force`, `--no-coldstart`, `--no-parallax`, `--no-premortem`.

    On a successful compile, the gate pipeline also projects the ticket set
    into `.adlc/tickets.json` (so the `adlc` CLI and the adlc-antigravity
    plugin's rails-guard hook can resolve the same active tickets), runs
    `adlc model-router` to assign each ticket's deterministic tier
    (replacing the brain conversion's own free-form guess), and `adlc
    merge-forecast` to annotate `plan.concurrencyCap`. All three are
    additive evidence — an unavailable `adlc` CLI degrades gracefully, it
    never fails an otherwise-successful compile.

   <details>
   <summary>Escape hatch: hand-writing plan.json (no brain artifact)</summary>

   Start from [templates/plan.example.json](templates/plan.example.json):

   ```json
   {
     "repo": "/abs/path/to/target-repo",
     "base": "main",
     "gate": { "build": "npm run typecheck", "test": "npm test" },
     "tickets": [
       {
         "id": "T1",
         "title": "math utilities",
         "body": "Full self-contained instruction text. The builder sees ONLY this plus the repo — name files, acceptance criteria, and edge cases explicitly.",
         "scope": ["lib/math.mjs", "test/math.test.mjs"],
         "rails": ["lib/contracts/**"],
         "edges": [{ "to": "T3" }],
         "tier": "cheap",
         "pool_hint": "gemini"
       }
     ]
   }
   ```

   Field rules (enforced by `agb validate`): `body` non-empty (it becomes
   the builder's entire specification); `scope` a non-empty glob list
   (out-of-scope changes fail the strike); `rails` are read-only globs
   enforced mechanically even inside scope; `edges` are
   this-ticket-blocks-`to` dependencies; `tier` ∈ cheap|mid|frontier and
   `pool_hint` ∈ gemini|claude|auto must be routable (e.g. `cheap`+`claude`
   is rejected — the cheap tier has no Claude-family model).

   Hand-written plans skip the compile gates, so run them yourself:

   ```sh
   agb validate plan.json     # schema + DAG + routability; exit 0/2
   agb preflight plan.json    # scope-overlap forecast + coldstart probe; exit 0/2
   ```
   </details>

2. Run it:

   ```sh
   agb run plan.json          # build → gate → prosecute → merge; exit 0/2
   ```

3. Watch and read results:

   ```sh
   agb status /path/to/target-repo           # one-shot snapshot of the current run
   agb status /path/to/target-repo --watch   # refresh in place (--interval <ms>)
   agb sidecar /path/to/target-repo          # start the local web dashboard sidecar
   ```

   Per-ticket transcripts land in `.booster/logs/<run-id>/<ticketId>.jsonl`, the final
   report (merged/failed/per-pool request counts) in
   `.booster/report.json` and on stdout. Exit codes everywhere:
   **0** all merged, **2** gate failure / findings / failed tickets,
   **1** usage or internal error.

Each ticket builds in its own worktree under `.worktrees/`, gates run
sandboxed in the worktree, a cross-family prosecutor reviews the diff
(critical/high findings trigger one fix round), then merges are sequential
rebase-first with a post-merge gate on main — a failed post-merge gate
reverts main to the exact pre-merge SHA. Two strikes per ticket, then it
fails and blocks its dependents.

## All commands

```sh
agb bootstrap                  # install the adlc-antigravity plugin + link booster's own skills
agb brains                     # list Antigravity plan artifacts (GUI + agy)
agb plan <brain-id | spec.md> /repo # compile a plan (GUI brain or raw Markdown file): convert → gates → plan.json
agb validate plan.json         # check schema, DAG, routability
agb preflight plan.json        # plan gates: scope-overlap forecast + coldstart
agb run plan.json              # build → gate → prosecute → merge; exit 0/2
agb sweep sweep.json           # same operation × many targets (cheap tier)
agb review /repo [ref]         # read-only lens fleet, loop-until-dry; exit 0/2
agb doctor                     # verify your environment and tools
agb status /path/repo          # one-shot run snapshot (--watch [--interval <ms>])
agb sidecar /path/repo         # start the local web dashboard sidecar server
agb probe 2,4,8 [model]        # measure pool width/latency, append docs/calibration
agb import-brain <id> /repo    # DEPRECATED: raw one-shot conversion (use agb plan)
```

Workload modes map: greenfield/big-feature → plan in Antigravity →
`plan` → `run` (ticket DAG); fan-out sweeps → `sweep`; research/review
fleets → `review`. Loop-until-dry prosecution: set
`"prosecution": {"dryPasses": 2}` in the plan to require that many
consecutive clean prosecution passes before merge.

Sweep spec (`agb sweep`) — one operation fanned across targets, each
becoming a generated cheap-tier ticket with a disjoint scope:

```json
{
  "repo": "/abs/path",
  "gate": { "test": "npm test" },
  "operation": "Add JSDoc to every exported function in {target}.",
  "targetGlob": "src/**/*.mjs",
  "scopePerTarget": ["{target}"]
}
```

(`targets: []` instead of `targetGlob` for an explicit list; `{target}`
and `{i}` substitute into `operation` and `scopePerTarget`.)

Recursive mode: inside any agy session, the `adlc-self-orchestrate` skill
(installed by `agb bootstrap` via the adlc-antigravity plugin, not vendored
in this repo) teaches the agent to decompose work and drive `agb` itself.
See [docs/guidelines.md](docs/guidelines.md) and the plugin's
`skills/adlc-self-orchestrate/SKILL.md` for the decomposition doctrine
(foundation first, single writer per partition, self-contained tickets).

## Environment knobs

| Variable | Default | Effect |
|---|---|---|
| `AGB_BUILD_TIMEOUT` | `5m` | Per-builder agy timeout (agy hard-caps ~5m anyway; a timeout consumes a strike) |
| `AGB_SANDBOX_GATES` | sandbox on (darwin) | `0` runs gates unsandboxed — only inside a disposable container; non-darwin fails closed without it |
| `AGB_ALLOW_DIRTY` | refuse dirty repo | `1` skips the clean-tree guard — merge rollback uses `git reset --hard`, uncommitted work WILL be lost |
| `AGB_AGY_BIN` | `agy` | Alternate agy binary (tests point this at a fake) |
| `AGB_ADLC_BIN` | `adlc` | Alternate adlc CLI binary (tests point this at a fake) — used by every `adlc <tool>` integration: `rails-guard`, `model-router`, `merge-forecast`, `flail-detector`, `consensus-fix`, `gate-manifest`, `review-calibration` |
| `ADLC_ANTIGRAVITY_PLUGIN_PATH` | resolved from `node_modules` | Override where `agb bootstrap` finds the `@adlc/antigravity` plugin to install. Defaults to the installed npm package; falls back to a sibling `../adlc/plugins/adlc-antigravity` checkout |
| `AGB_PLUGIN_DIR` | `~/.gemini/config/plugins/adlc-antigravity` | Installed adlc-antigravity plugin dir; its `plugin.json` `adlcContract` is handshake-checked against the booster's supported contract (incompatible → abort before any repo mutation; missing/unreadable → warn + degrade). Tests point this at a fixture |
| `AGB_BRAIN_DIR` | `~/.gemini/antigravity/brain` | Where `agb brains`/`agb plan` look for Antigravity plan artifacts |
| `AGB_CALIBRATION_DIR` | `docs/calibration/` in this checkout | Where `agb probe` appends its measurement artifact |
| `ADLC_PROVIDER=agy` | — | Run `@adlc` gate tools (parallax, premortem, …) on Antigravity quota |

## Testing

```sh
npm test    # node:test suite, fully offline (fake-agy + fake-adlc fixtures)
```

Sandbox-specific security tests are darwin-gated; scheduler tests run
gates unsandboxed so the suite is green on any platform.

## Layout

```
bin/agb.mjs        CLI (bootstrap | plan | run | sweep | review | preflight |
                   brains | status | probe | validate)
lib/               scheduler, pools, agy wrapper, worktrees, gates,
                   charters, prosecution, review, sweep, preflight,
                   plan compiler (validate/parallax/premortem),
                   adlc-bridge (plan.json ⇄ .adlc/tickets.json projection),
                   brain import, bootstrap, status, repo lock
skills/            release (booster-specific; ADLC doctrine/prosecutor/
                   self-orchestrate skills come from the adlc-antigravity
                   plugin, installed by `agb bootstrap`, not vendored here)
templates/         plan.example.json (schema by example)
.adlc/             this repo's own ADLC workspace (tickets.json tracked,
                   config.json tracked, everything else gitignored)
.github/workflows/ ci.yml (npm test) + adlc-rails-guard.yml (CI rail-freeze
                   backstop, dogfooding the same doctrine this tool imposes)
docs/research/     agy CLI + Antigravity 2.0 platform findings
docs/calibration/  probed latency/concurrency/sandbox facts
```

## Facts the design stands on (all probed locally)

- `agy --print` reads stdin, loads `AGENTS.md`/`GEMINI.md` from cwd, sees
  global skills, writes files and runs commands non-interactively, and
  **exits 0 even on timeout** (assert on output, never exit codes).
- `--sandbox` (macOS) permits git/npm/node/network — builders run sandboxed.
- Gemini Flash pool degrades past width 8; Claude pool is unaffected by
  concurrent Gemini load. Claude models have the lowest fixed overhead.

Calibration: [probes-2026-07-14.md](docs/calibration/probes-2026-07-14.md)
(earlier: [probes-2026-06-11.md](docs/calibration/probes-2026-06-11.md)).

## Stability

Pre-1.0 and versioned with semver's pre-1.0 latitude: **minor versions may carry
breaking changes**, patch versions will not. Pin a minor (`~0.3.0`) if you need
the CLI surface, the `plan.json` schema, or the `.booster/` artifact layout to
hold still. Breaking changes are called out in [CHANGELOG.md](CHANGELOG.md).

Only the latest published version receives fixes, including security fixes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md)
— please do not open a public issue for a vulnerability.
