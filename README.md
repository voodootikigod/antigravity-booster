# antigravity-booster

Make Google Antigravity 2.0 (`agy` CLI + GUI) effective for large parallel
build-outs. Implements the [ADLC](../aidlc/ADLC.md) on Antigravity:
deterministic orchestration, quota-pool-aware scheduling, cross-model
prosecution, and gate-shaped validation — ideation to merge.

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

- **Node ≥ 18** (zero runtime dependencies beyond the sibling
  [`@aidlc/core`](../aidlc) checkout — see `package.json`).
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

### Option A: Zero-Install (npx)
Perfect for quick runs or ephemeral environments. This automatically downloads the package and installs the ADLC skills into your `~/.gemini/skills` directory:
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
If you cloned the repository locally and want to link the CLI and symlink the skills:
```sh
npm install && npm link
agb bootstrap
```

### Integration Configuration (Optional)
To route general `aidlc` tools through your Antigravity session and quota:
```sh
export AIDLC_PROVIDER=agy
```

## Quickstart

1. Write a plan (start from
   [templates/plan.example.json](templates/plan.example.json)):

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

2. Validate, forecast, run:

   ```sh
   agb validate plan.json     # schema + DAG + routability; exit 0/2
   agb preflight plan.json    # scope-overlap forecast + coldstart probe; exit 0/2
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
agb validate plan.json         # check schema, DAG, routability
agb preflight plan.json        # plan gates: scope-overlap forecast + coldstart
agb run plan.json              # build → gate → prosecute → merge; exit 0/2
agb sweep sweep.json           # same operation × many targets (cheap tier)
agb review /repo [ref]         # read-only lens fleet, loop-until-dry; exit 0/2
agb brains                     # list Antigravity GUI plan artifacts
agb import-brain <id> /repo    # GUI plan → plan.json (frontier conversion)
agb status /path/repo          # live dashboard (.booster/run.json)
agb probe 2,4,8 [model]        # measure pool width/latency, append docs/calibration
```

Workload modes map: greenfield/big-feature → `run` (ticket DAG);
fan-out sweeps → `sweep`; research/review fleets → `review`. Hybrid GUI
pipeline: plan in the Antigravity desktop app → `import-brain` →
`preflight` → `run`. Loop-until-dry prosecution: set
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
teaches the agent to decompose work and drive `agb` itself. See
[docs/guidelines.md](docs/guidelines.md) and `skills/adlc-self-orchestrate/SKILL.md` for the
decomposition doctrine (foundation first, single writer per partition,
self-contained tickets).

## Environment knobs

| Variable | Default | Effect |
|---|---|---|
| `AGB_BUILD_TIMEOUT` | `5m` | Per-builder agy timeout (agy hard-caps ~5m anyway; a timeout consumes a strike) |
| `AGB_SANDBOX_GATES` | sandbox on (darwin) | `0` runs gates unsandboxed — only inside a disposable container; non-darwin fails closed without it |
| `AGB_ALLOW_DIRTY` | refuse dirty repo | `1` skips the clean-tree guard — merge rollback uses `git reset --hard`, uncommitted work WILL be lost |
| `AGB_AGY_BIN` | `agy` | Alternate agy binary (tests point this at a fake) |
| `AGB_CALIBRATION_DIR` | `docs/calibration/` in this checkout | Where `agb probe` appends its measurement artifact |
| `AIDLC_PROVIDER=agy` | — | Run aidlc gate tools (parallax, premortem, …) on Antigravity quota |

## Testing

```sh
npm test    # 57 node:test cases, fully offline (fake agy fixture)
```

Sandbox-specific security tests are darwin-gated; scheduler tests run
gates unsandboxed so the suite is green on any platform.

## Layout

```
bin/agb.mjs        CLI (run | sweep | review | preflight | brains |
                   import-brain | status | probe | validate)
lib/               scheduler, pools, agy wrapper, worktrees, gates,
                   charters, prosecution, review, sweep, preflight,
                   brain import, status, repo lock
skills/            adlc-doctrine, adlc-prosecutor, adlc-self-orchestrate
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
