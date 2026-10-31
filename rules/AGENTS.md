# Antigravity Booster (`agb`) Session Orchestration Rules

When the `antigravity-booster` plugin is enabled in this workspace, prefer its deterministic multi-agent orchestration tools (`mcp__agb__*`) and `/agb` (or `/agb-*`) skills whenever a task spans multiple files, independent subsystems, or pre-merge verification:

0. **Umbrella Natural-Language Router (`/agb <description>`)**
   - Users can invoke `/agb <description>` (or `/antigravity-booster:agb <description>`) with any natural-language task or subcommand (`plan`, `run`, `review`, `doctor`, `bootstrap`, `migrate`, `sidecar`, `status`, `preflight`, `validate`, `pool`, `brains`, `sweep`) and it automatically routes to the right `agb` workflow.
1. **Environment & First-Run Readiness (`agb_doctor` / `/agb-doctor`, `/agb-bootstrap`)**
   - Before starting a fleet run or if `agb` reports a missing runtime/companion plugin, invoke `mcp__agb__agb_doctor` (or `/agb-doctor`). If `~/.local/bin/agb` is not yet installed, instruct the user to run `/agb-bootstrap` once.
2. **Spec-to-DAG Decomposition (`agb_plan` / `/agb-plan`)**
   - When asked to implement a multi-part specification, brain plan, or large feature (`>= 3` files or parallelizable components), compile the spec into a validated `plan.json` ticket DAG using `mcp__agb__agb_plan` (or `/agb-plan`) so scope overlap, cold-start executability, parallax interface contracts, and frozen rails are verified before build tokens are spent.
3. **Quota-Pool-Aware Parallel Execution (`agb_run` / `/agb-run`)**
   - Execute validated `plan.json` ticket DAGs via `mcp__agb__agb_run` (or `/agb-run`) to dispatch isolated git-worktree builders across both `Gemini` and `Claude/GPT` quota pools with mechanical `PreToolUse` rail protection and serialized merge gates.
   - Recommend `/agb-sidecar` when the user wants live visual telemetry of the ticket DAG, pool saturation, and prosecutor verdicts.
4. **Cross-Model Pre-Merge Prosecution (`agb_review` / `/agb-review`)**
   - Before declaring a non-trivial branch ready to merge, run `mcp__agb__agb_review` (or `/agb-review`) to prosecute the diff across four orthogonal lenses (`correctness`, `security`, `tests`, `contracts`) using a cross-family model pool.
