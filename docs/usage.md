# CLI Usage & Configuration

This guide details how to configure and run Antigravity Booster (`agb`) to manage agentic workflows.

## Table of Contents
1. [Command Reference](#command-reference)
2. [Plan Schema (plan.json)](#plan-schema-planjson)
3. [Sweep Schema (sweep.json)](#sweep-schema-sweepjson)
4. [Environment Variables](#environment-variables)
5. [Operational Best Practices](#operational-best-practices)

---

## Command Reference

`agb` is a command-line interface with several subcommands designed for verification, execution, review, and status tracking.

### `agb validate <plan.json>`
Validates a plan file before running.
- Checks JSON schema conformity.
- Validates that the dependency structure is a directed acyclic graph (DAG) (i.e., no cycles).
- Validates model routability (checks that the requested `tier` and `pool_hint` mapping can be routed to an actual model pool).
- **Exit codes:** `0` if valid; `2` if validation fails.

### `agb preflight <plan.json>`
Performs preflight checks to forecast conflicts and verify environment readiness.
- Predicts scope overlaps between independent parallel branches.
- Executes coldstart latency checks for all configured model pools.
- **Exit codes:** `0` if successful; `2` if check fails.

### `agb run <plan.json>`
Executes a ticket DAG from `plan.json`.
- Dispatches workers in separate git worktrees under `.worktrees/`.
- Executes sandboxed build and test commands (L2 gates).
- Runs cross-model prosecution reviews on generated diffs.
- Sequentially rebases and merges passing work to the target base branch on `main`.
- Reverts to the previous HEAD if the post-merge gate fails.
- **Exit codes:** `0` if all tickets are merged successfully; `2` if gates fail, critical bugs are found, or tickets exhaust their retry limits.

### `agb sweep <sweep.json>`
Runs a fan-out sweep across many targets.
- Used when you need to apply the exact same instruction (e.g., "Add JSDoc to every file") across dozens of files.
- Automatically generates cheap-tier tickets for each target with disjoint file scopes.
- Executes them concurrently, observing pool concurrency limits.
- **Exit codes:** `0` if all sweep targets are processed and merged; `2` if any fail.

### `agb review <repo> [ref]`
Deploys a read-only fleet of models to audit changes.
- Analyzes the diff in a repository at a given reference (defaults to HEAD).
- Iteratively reviews the code and loops until dry (runs until no new critical/high findings are generated).
- **Exit codes:** `0` if no critical/high issues are found; `2` if findings block approval.

### `agb brains`
Lists plan artifacts synced from the Antigravity desktop GUI app.
- Used for L4 hybrid operation, showing what GUI plans are available to import.

### `agb import-brain <id> <repo>`
Converts a GUI-generated plan into a standardized `plan.json`.
- Takes a brain artifact ID and imports it as a ticket DAG targeting `<repo>`, converting high-level tasks into structured `agb` tickets.

### `agb status <repo>`
Displays a live dashboard of an ongoing run.
- Reads state from `.booster/run.json` inside the target repository.
- Shows active workers, active phases, models in use, current queues, and accumulated request counts per pool.

### `agb probe <concurrencies> [model]`
Measures pool latency and width limits.
- Examples: `agb probe 2,4,8` or `agb probe 4 gemini-3.5-flash-low`.
- Tests concurrency thresholds by firing parallel sentinel prompts and verifying outputs and times.
- Appends results as an updated markdown file in the calibration directory.

---

## Plan Schema (plan.json)

The `plan.json` file describes the target repository, validation commands, and the list of tickets to be run.

```json
{
  "repo": "/absolute/path/to/target-repo",
  "base": "main",
  "gate": {
    "build": "npm run typecheck",
    "test": "npm test"
  },
  "prosecution": {
    "dryPasses": 1
  },
  "tickets": [
    {
      "id": "T1",
      "title": "Build math utilities",
      "body": "Create a mathematical utilities file containing add, subtract, multiply, and divide. Include type declarations and comprehensive tests.",
      "scope": ["lib/math.mjs", "test/math.test.mjs"],
      "rails": ["lib/contracts/**"],
      "edges": [{ "to": "T2" }],
      "tier": "cheap",
      "pool_hint": "gemini"
    },
    {
      "id": "T2",
      "title": "Build statistics utilities",
      "body": "Create statistics utilities utilizing T1's math module to compute mean and median. Add tests.",
      "scope": ["lib/stats.mjs", "test/stats.test.mjs"],
      "rails": ["lib/contracts/**"],
      "edges": [],
      "tier": "mid",
      "pool_hint": "auto"
    }
  ]
}
```

### Field Definitions

| Field | Type | Description |
| :--- | :--- | :--- |
| `repo` | String | Absolute path to the local git repository. Must have a clean working tree. |
| `base` | String | Target branch to branch off of and merge back into (typically `main`). |
| `gate` | Object | Verification scripts: `build` (compilation/linting) and `test` (test suites). |
| `prosecution` | Object | *Optional*. Configures prosecution rules. `dryPasses` is the number of consecutive clean reviews required before merge. |
| `tickets` | Array | A DAG of self-contained tasks. |

### Ticket Field Definitions

- **`id`**: Unique string identifier (e.g., `"T1"`).
- **`title`**: Short descriptive title.
- **`body`**: The entire specification sent to the builder model. It must contain all context needed to execute the work standalone: filenames, interfaces, exact acceptance criteria. If this is empty, `agb validate` will reject the plan.
- **`scope`**: Non-empty array of file path globs. The builder is mechanically restricted to modifying *only* files matching these globs. Any modification outside this scope triggers an automatic strike.
- **`rails`**: Array of read-only file path globs. Rails are frozen and cannot be modified by the builder. If a rail file is edited, the build fails. If the builder believes a rail must be edited, it must halt and output `TICKET-BLOCKED`.
- **`edges`**: List of dependency edges (`{"to": "target_id"}`) representing "this ticket blocks `to`". In the example above, `T1` must merge successfully before `T2` starts building.
- **`tier`**: Execution tier (`cheap`, `mid`, or `frontier`). Governs model selection based on complexity.
- **`pool_hint`**: Quota pool preference (`gemini`, `claude`, or `auto`).

---

## Sweep Schema (sweep.json)

A sweep executes a single instruction across a set of target files.

```json
{
  "repo": "/absolute/path/to/target-repo",
  "gate": {
    "test": "npm test"
  },
  "operation": "Add standard JSDoc comments to all exported functions in {target}.",
  "targetGlob": "src/**/*.mjs",
  "scopePerTarget": ["{target}"],
  "concurrency": 4
}
```

### Sweep Field Definitions

- **`repo`**: Absolute path to the local repository.
- **`gate`**: Test/verification gate commands.
- **`operation`**: The instruction text template. `{target}` and `{i}` can be interpolated.
- **`targetGlob`**: Glob pattern to locate target files. Alternatively, specify a `"targets": [...]` array to explicitly name files.
- **`scopePerTarget`**: Globs representing the allowed scope relative to each target.
- **`concurrency`**: Concurrency limit for execution.

---

## Environment Variables

Modify these flags in your shell to adjust how `agb` runs:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `AGB_BUILD_TIMEOUT` | `5m` | Maximum time allowed for one `agy` build call. Excess causes a strike. (Hard capped at ~5m by the platform). |
| `AGB_SANDBOX_GATES` | `1` (on macOS) | Enforces macOS Seatbelt sandboxing for all gate scripts. Set to `0` to disable sandboxing (e.g., when running inside Docker containers on Linux). |
| `AGB_ALLOW_DIRTY` | `0` | Set to `1` to bypass the clean git directory check. *Caution: Rollbacks use git resets, which will discard uncommitted changes.* |
| `AGB_AGY_BIN` | `agy` | Custom path to the Antigravity CLI binary. Used mainly for testing with mock wrappers. |
| `AGB_CALIBRATION_DIR` | `docs/calibration/` | Target directory where `agb probe` writes result reports. |
| `AIDLC_PROVIDER` | — | Set to `agy` to route general aidlc package execution through Antigravity CLI credentials. |

---

## Operational Best Practices

### Ticket Sizing
Because of the platform's ~5-minute hard timeout on print-mode calls:
- Keep tickets focused on small, single-file or dual-file scopes.
- Break large features into a foundation pass followed by parallel feature tickets.
- Do not let builders write large, slow-to-generate files from scratch. Provide empty skeleton files or interfaces first.

### Managing Quotas
- Monitor weekly quotas. A run of $N$ tickets typically costs $2N$ to $4N$ requests due to validation, prosecution, and retry loops.
- Use the `cheap` tier (Gemini Flash) for tasks that are well-covered by deterministic testing gates. Save `mid` and `frontier` tiers for logic involving complex integration contracts.

### Handling Blocked Tickets
- When a ticket fails twice, `agb` flags it as failed and halts its dependent tickets.
- Do not try to run the plan again without modifying the ticket. A ticket failing twice indicates that the requirements in the `body` are either ambiguous, conflicting with a read-only rail, or too large.
- Edit the `body` to be more explicit, split the scope, or fix the underlying API contracts, and run again.
