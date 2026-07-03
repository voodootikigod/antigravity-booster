# antigravity-booster

Make Google Antigravity 2.0 (`agy` CLI + GUI) effective for large parallel
build-outs. Implements the [ADLC](../adlc/ADLC.md) on Antigravity:
deterministic orchestration, quota-pool-aware scheduling, cross-model
prosecution, and gate-shaped validation — ideation to merge.

## Documentation

Full guides, specifications, and walkthroughs are available:
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
  and vice versa, with a refute charter and a JSON verdict contract.
  Critical/high findings block the merge and trigger one fix round.
- **Deterministic gates.** Build/test commands gate every ticket in its
  worktree and again post-merge on main (failed post-merge gate = revert).
- **Two-strike regeneration.** A flailing worker is never coached; the
  ticket re-runs fresh with dead-ends appended, then fails to escalation.

## Requirements

- **Node ≥ 18** (one runtime dependency, [`@adlc/core`](https://www.npmjs.com/package/@adlc/core) from the npm registry — see `package.json`).
- **`agy` CLI** on PATH with an active Antigravity session
  (`curl -fsSL https://antigravity.google/cli/install.sh | bash`).
- **macOS** for sandboxed gates (Seatbelt). On Linux/Windows, gates
  **fail closed** by design; run inside a disposable container and set
  `AGB_SANDBOX_GATES=0` to acknowledge the container is your isolation
  boundary.
- A **target git repository** that is on the plan's base branch with a
  clean working tree (the run refuses otherwise — merges and rollbacks
  act on the checked-out branch).

## Install

You can run `antigravity-booster` directly using `npx`, or install it globally/locally via `npm`.

`agb bootstrap` installs the [`adlc-antigravity`](../adlc/plugins/adlc-antigravity)
plugin (via `agy plugin install`) — the source of the ADLC doctrine,
prosecutor, and self-orchestrate skills, plus the rails-guard hook. Booster
does not vendor its own copies of that doctrine; it depends on the plugin
as a sibling `../adlc` checkout by default (override with
`ADLC_ANTIGRAVITY_PLUGIN_PATH` if it lives elsewhere) — the plugin itself is
unpublished (`private: true`), unlike `@adlc/core`, which resolves from the
npm registry like any other dependency. `agy plugin install` requires an
`agy` CLI recent enough to support plugin installation; bootstrap fails
loudly, not silently, if the plugin path is missing or the install itself
fails.

### Option A: Zero-Install (npx)
Perfect for quick runs or ephemeral environments. This automatically downloads the package, installs the adlc-antigravity plugin, and links booster's own skills:
```sh
npx antigravity-booster bootstrap
```

### Option B: Global Installation
To install the `agb` CLI command globally:
```sh
npm install -g antigravity-booster
agb bootstrap
```

### Option C: Development/Source Installation
If you cloned the repository locally and want to link the CLI and symlink booster's own skills (checkout `../adlc` as a sibling first if you also want `agb bootstrap` to install the adlc-antigravity plugin from source):
```sh
npm install && npm link
agb bootstrap
```

### Integration Configuration (Optional)
To route general `@adlc` tools through your Antigravity session and quota:
```sh
export ADLC_PROVIDER=agy
```

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
   agb status /path/to/target-repo    # live dashboard from .booster/run.json
   ```

   Per-ticket transcripts land in `.booster/logs/<run-id>/`, the final
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
agb brains                     # list Antigravity plan artifacts (GUI + agy)
agb plan <brain-id | spec.md> /repo # compile a plan (GUI brain or raw Markdown file): convert → gates → plan.json
agb validate plan.json         # check schema, DAG, routability
agb preflight plan.json        # plan gates: scope-overlap forecast + coldstart
agb run plan.json              # build → gate → prosecute → merge; exit 0/2
agb sweep sweep.json           # same operation × many targets (cheap tier)
agb review /repo [ref]         # read-only lens fleet, loop-until-dry; exit 0/2
agb status /path/repo          # live dashboard (.booster/run.json)
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
| `AGB_BRAIN_DIR` | `~/.gemini/antigravity/brain` | Where `agb brains`/`agb plan` look for Antigravity plan artifacts |
| `AGB_CALIBRATION_DIR` | `docs/calibration/` in this checkout | Where `agb probe` appends its measurement artifact |
| `ADLC_PROVIDER=agy` | — | Run `@adlc` gate tools (parallax, premortem, …) on Antigravity quota |

## Testing

```sh
npm test    # 77 node:test cases, fully offline (fake agy fixture)
```

Sandbox-specific security tests are darwin-gated; scheduler tests run
gates unsandboxed so the suite is green on any platform.

## Layout

```
bin/agb.mjs        CLI (plan | run | sweep | review | preflight | brains |
                   status | probe | validate)
lib/               scheduler, pools, agy wrapper, worktrees, gates,
                   charters, prosecution, review, sweep, preflight,
                   plan compiler (validate/parallax/premortem),
                   brain import, status, repo lock
skills/            release (booster-specific; ADLC doctrine/prosecutor/
                   self-orchestrate skills come from the adlc-antigravity
                   plugin, installed by `agb bootstrap`, not vendored here)
templates/         plan.example.json (schema by example)
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

Calibration: [docs/calibration/probes-2026-06-11.md](docs/calibration/probes-2026-06-11.md).
