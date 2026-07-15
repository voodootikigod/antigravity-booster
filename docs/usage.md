# CLI Usage & Configuration

This guide details how to configure and run Antigravity Booster (`agb`) to manage agentic workflows.

## Table of Contents
1. [Where Planning Happens](#where-planning-happens)
2. [Command Reference](#command-reference)
3. [Plan Schema (plan.json)](#plan-schema-planjson)
4. [Sweep Schema (sweep.json)](#sweep-schema-sweepjson)
5. [Environment Variables](#environment-variables)
6. [Operational Best Practices](#operational-best-practices)

---

## Where Planning Happens

**Planning happens in Antigravity, exactly as it already does.** `agb` does not replace or supplement Antigravity's plan phase. Use the planning surface you already use — the desktop app's plan mode or a planning conversation in an `agy` session. Both write the same brain artifact (`implementation_plan.md` under `~/.gemini/antigravity/brain/<conversation>/`), and that artifact is the **source of truth** for the plan.

`agb` enters only after the plan exists: `agb plan` compiles the brain artifact or local raw spec file into an executable `plan.json` ticket DAG and runs plan-time gates over the result. When a gate finds a problem it cannot fix by re-converting, the remediation is always the same: **go back to the plan in Antigravity or edit your local raw spec file, refine it there, and re-run `agb plan`** — never hand-patch the compiled JSON. Hand-writing `plan.json` remains supported as an escape hatch for work that has no brain artifact, but it skips the compile gates (run `agb validate` and `agb preflight` yourself).

---

## Command Reference

`agb` provides subcommands grouped into four main workflows: Setup, Planning, Execution, and Monitoring.

### 🛠️ Setup & Diagnostics
- **`agb bootstrap`** (aliases: `setup`, `install`)  
  Installs the required `adlc-antigravity` plugin and links booster's skills. Use `--force` to overwrite existing skills. Fails loudly if `agy` is missing.
- **`agb probe <concurrencies> [model]`**  
  Measures pool latency and width limits (e.g., `agb probe 2,4,8`). Appends results to the calibration directory.

### 🧠 Planning & Validation
- **`agb brains`**  
  Lists your Antigravity plan artifacts (from the GUI or `agy` sessions), newest first.
- **`agb plan <brain-id | spec.md> <repo> [--out plan.json]`**  
  Compiles a plan artifact into an executable `plan.json` ticket DAG. Runs deterministic gates (structural, coldstart, parallax, premortem) to catch errors early.
- **`agb validate <plan.json>`**  
  Checks JSON schema conformity, validates DAG structure (no cycles), and verifies model routability.
- **`agb preflight <plan.json>`**  
  Forecasts scope overlaps between parallel tickets and runs coldstart latency checks.

### 🚀 Execution
- **`agb run <plan.json>`**  
  Executes the ticket DAG. Dispatches workers in isolated worktrees, assigns each worker a dedicated project isolation boundary (e.g. `--project "agb-<runId>-<ticketId>"`), runs sandboxed L2 gates, orchestrates cross-model prosecution, and sequentially rebases/merges passing work. Reverts if the post-merge gate fails.
- **`agb sweep <sweep.json>`**  
  Runs a fan-out sweep. Applies a single instruction across dozens of targets concurrently (e.g., "Add JSDoc to every file").
- **`agb review <repo> [ref]`**  
  Deploys a read-only fleet of models to audit changes. Loops until dry (no new critical/high findings).

### 📊 Monitoring
- **`agb status <repo>`**  
  Displays a live dashboard of an ongoing run (shows active workers, queues, and request counts).

### 📝 Log Schemas

**`events.jsonl` (Global Run Events)**  
Located at `.booster/logs/<runId>/events.jsonl`. Appended atomically during the run.
- `ts`: ISO 8601 timestamp.
- `runId`: The unique run identifier.
- `type`: Event type (`phase`, `pool`, `strike`, or `report`).
- `ticket`: The ticket ID (for phase and strike events).
- `from`, `to`: The phase transition for the ticket.
- `detail`: Optional detail string about the phase.
- `pools`: The active state of all quota pools (for pool events).
- `model`, `error`, `strikes`: Information about a strike (for strike events).
- `done`, `report`: Final run summary (for report events).

**`<ticketId>.jsonl` (Per-Ticket Transcript)**  
Located at `.booster/logs/<runId>/<ticketId>.jsonl`.
- `ts`: ISO 8601 timestamp.
- `role`: Role of the agent (`builder` or `prosecutor`).
- `model`: Model name used.
- `strike`: The current strike number (for builders) or 0 (for prosecutors).
- `ms`: Execution time in milliseconds.
- `ok`: Boolean indicating if the model call succeeded (no crash/timeout).
- `error`, `kind`: Error message and type (e.g., `timeout`, `server`, `spawn`) if `ok` is false.
- `prompt`: The full text of the prompt sent to the model.
- `output`: The raw text output received from the model.
- `cwd`: The working directory the model executed in.

*(Note: `agb import-brain` is deprecated. Use `agb plan` instead.)*


---

## Plan Schema (plan.json)

The `plan.json` file describes the target repository, validation commands, and the list of tickets to be run. It is normally **compiler output** (`agb plan` produces it from an Antigravity brain artifact, including a `source` provenance field); hand-write it only when no brain artifact exists.

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
| `source` | Object | *Optional; written by `agb plan`.* Provenance of the compiled plan: `{"type": "antigravity-brain", "id": "<conversation>", "title": "..."}`. |
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
| `AGB_ADLC_BIN` | `adlc` | Custom path to the adlc CLI binary. Used by every `adlc <tool>` integration (rails-guard, model-router, merge-forecast, flail-detector, consensus-fix, gate-manifest, review-calibration) and for testing with mock wrappers. |
| `ADLC_ANTIGRAVITY_PLUGIN_PATH` | `../adlc/plugins/adlc-antigravity` | Where `agb bootstrap` finds the (unpublished) adlc-antigravity plugin to install. |
| `AGB_PLUGIN_DIR` | `~/.gemini/config/plugins/adlc-antigravity` | Installed adlc-antigravity plugin directory; its `plugin.json` `adlcContract` field is handshake-checked against the booster's supported contract before enabling live rail enforcement. Incompatible → the run aborts before any repo mutation; missing/unreadable → warns and degrades. Tests point this at a fixture directory. |
| `AGB_BRAIN_DIR` | `~/.gemini/antigravity/brain` | Where `agb brains` and `agb plan` look for Antigravity plan artifacts. |
| `AGB_CALIBRATION_DIR` | `docs/calibration/` | Target directory where `agb probe` writes result reports. |
| `ADLC_PROVIDER` | — | Set to `agy` to route general `@adlc` package execution through Antigravity CLI credentials. |

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
- A ticket can exhaust its strikes two ways: it fails twice, or `adlc flail-detector` diagnoses a genuine flail pattern (repeated errors, scope violations, edit churn, an oversized log) in the accumulated log after strike one and skips the second strike entirely rather than wasting it on a dead end. Either way, `agb` flags the ticket as failed and halts its dependent tickets.
- Do not try to run the plan again without modifying the ticket. A blocked ticket indicates that the requirements in the `body` are either ambiguous, conflicting with a read-only rail, or too large.
- Edit the `body` to be more explicit, split the scope, or fix the underlying API contracts, and run again.
- Check `.adlc/manifest.jsonl` (`adlc gate-manifest show`) for the exact gate sequence that led to the failure — build/prosecution/rollback outcomes are recorded there as append-only evidence, not just in `.booster/report.json`.
