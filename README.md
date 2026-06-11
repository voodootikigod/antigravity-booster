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

## Install

```sh
npm install && npm link     # provides `agb`
./install.sh                # links ADLC skills into ~/.gemini/skills
export AIDLC_PROVIDER=agy   # optional: run aidlc gate tools on Antigravity quota
```

## Use

```sh
agb validate plan.json         # check the ticket DAG
agb preflight plan.json        # plan gates: scope-overlap forecast + coldstart
agb run plan.json              # build → gate → prosecute → merge; exit 0/2
agb sweep sweep.json           # same operation × many targets (cheap tier)
agb review /repo [ref]         # read-only lens fleet, loop-until-dry; exit 0/2
agb brains                     # list Antigravity GUI plan artifacts
agb import-brain <id> /repo    # GUI plan → plan.json (frontier conversion)
agb status /path/repo          # live dashboard (.booster/run.json)
agb probe 2,4,8                # re-measure pool concurrency ceilings
```

Workload modes map: greenfield/big-feature → `run` (ticket DAG);
fan-out sweeps → `sweep`; research/review fleets → `review`. Hybrid GUI
pipeline: plan in the Antigravity desktop app → `import-brain` →
`preflight` → `run`. Loop-until-dry prosecution: set
`"prosecution": {"dryPasses": 2}` in the plan.

Plan format: aidlc ticket schema (`id`, `title`, `body`, `scope`, `rails`,
`edges`, plus booster's `tier` and `pool_hint`) — see
[SPEC.md](SPEC.md) and `skills/adlc-self-orchestrate/SKILL.md` for a full
example and the decomposition doctrine (foundation first, single writer per
partition, self-contained tickets).

Recursive mode: inside any agy session, the `adlc-self-orchestrate` skill
teaches the agent to decompose work and drive `agb` itself.

## Layout

```
bin/agb.mjs        CLI (run | validate | status | probe)
lib/               scheduler, pools, agy wrapper, worktrees, gates,
                   charters, prosecution, status
skills/            adlc-doctrine, adlc-prosecutor, adlc-self-orchestrate
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
