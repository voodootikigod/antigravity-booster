# Antigravity Booster Usage Guide

`antigravity-booster` (`agb`) orchestrates **Google Antigravity** (`agy` CLI) and **JetSki** (`agentapi` subagent environment) for large, parallel, disciplined software build-outs.

---

## 1. Quickstart & Workflow Overview

### Standard Workflow Phases

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ 1. Plan         │ ───► │ 2. Compile      │ ───► │ 3. Execute      │ ───► │ 4. Monitor      │
│ In Antigravity  │      │ agb plan        │      │ agb run         │      │ agb status      │
└─────────────────┘      └─────────────────┘      └─────────────────┘      └─────────────────┘
```

1. **Plan in Antigravity or Write a Spec**: Create a plan artifact (`implementation_plan.md`) in Antigravity GUI / `agy` session, or write a raw spec file (`spec.md`).
2. **Compile with `agb plan`**: Compile the spec into an executable ticket DAG (`plan.json`) with automated plan-time gates.
3. **Execute with `agb run`**: Run the ticket DAG across isolated worktrees, quota pools, sandboxed gates, and cross-model prosecutors.
4. **Monitor with `agb status` & `agb sidecar`**: Inspect real-time progress via terminal or native web dashboard.

---

## 2. Installation & Environment Integration

### Prerequisites

- **Node.js**: `>= 22.19.0`
- **Git**: `>= 2.38` (support for `git worktree`)
- **CLI Runtime**:
  - **Standalone Antigravity**: [`agy`](file:///Users/voodootikigod/Projects/antigravity-booster/lib/agy.mjs) CLI installed and authenticated on `PATH`.
  - **JetSki Environment**: `agentapi` CLI available (`AGB_PROVIDER=jetski`).

### 1. Installation

Install globally via npm or link from source:

```bash
# Global install via npm
npm install -g antigravity-booster

# Or link from a local clone
git clone git@github.com:voodootikigod/antigravity-booster.git
cd antigravity-booster
npm link
```

### 2. Bootstrapping

Run [`agb bootstrap`](file:///Users/voodootikigod/Projects/antigravity-booster/lib/bootstrap.mjs) to install the `@adlc/antigravity` plugin and link ADLC skills into `~/.gemini/skills`:

```bash
agb bootstrap
```

*(Under `AGB_PROVIDER=jetski`, `agb bootstrap` auto-detects JetSki mode and links skills directly).*

### 3. Diagnostic Health Check

Run [`agb doctor`](file:///Users/voodootikigod/Projects/antigravity-booster/lib/doctor.mjs) to verify your tools, quota pools, and sandbox setup:

```bash
agb doctor
```

---

## 3. Command Reference

### `agb bootstrap`

Installs the `@adlc/antigravity` plugin globally, registers sidecar definitions, and links booster skills into `~/.gemini/skills`.

```bash
agb bootstrap [--force]
```

- `--force`: Overwrites existing skill symlinks.

---

### `agb brains`

Lists Antigravity plan artifacts (`implementation_plan.md`) located in `~/.gemini/antigravity/brain/`, sorted newest first.

```bash
agb brains
```

---

### `agb plan`

Compiles a plan artifact (GUI brain ID or raw Markdown spec file) into an executable `plan.json` ticket DAG.

```bash
agb plan <brain-id | spec.md> <repo-path> [options]
```

**Options**:
- `--out <file>`: Output plan JSON path (default: `plan.json`).
- `--force`: Overwrite output file if it exists.
- `--no-coldstart`: Skip coldstart plan gate.
- `--no-parallax`: Skip parallax spec ambiguity gate.
- `--no-premortem`: Skip premortem advisory risk gate.

**Behavior**:
- Loops gate failures back into model re-conversion.
- Projects the compiled ticket DAG into the target repository's `.adlc/tickets/` directory store.
- Runs `adlc model-router` to assign deterministic model tiers.
- Runs `adlc merge-forecast` to annotate `concurrencyCap`.

---

### `agb validate`

Validates a hand-written `plan.json` against JSON schema, DAG cycle constraints, and model routability.

```bash
agb validate <plan.json>
```

---

### `agb preflight`

Runs plan-level coldstart probes and forecasts scope overlaps between parallel tickets.

```bash
agb preflight <plan.json>
```

---

### `agb run`

Executes the ticket DAG defined in `plan.json`.

```bash
agb run <plan.json> [options]
```

**Options**:
- `--concurrency <N>`: Override default concurrency cap.
- `--dry-run`: Validate DAG execution schedule without spawning workers.

**Execution Details**:
- Creates isolated git worktrees (`.worktrees/agb-<runId>-<ticketId>`).
- Enforces macOS Seatbelt / Linux `bwrap` sandboxed gates ([`lib/gates.mjs`](file:///Users/voodootikigod/Projects/antigravity-booster/lib/gates.mjs)).
- Runs cross-family refute-charter prosecution ([`lib/prosecute.mjs`](file:///Users/voodootikigod/Projects/antigravity-booster/lib/prosecute.mjs)).
- Sequential rebase and merge onto base branch with post-merge gate verification.
- Reverts to pre-merge SHA on post-merge gate failure.

---

### `agb sweep`

Executes a single operation across multiple target files concurrently.

```bash
agb sweep <sweep.json>
```

---

### `agb review`

Deploys a read-only fleet of models to audit changes until no new critical/high findings remain (loop-until-dry).

```bash
agb review <repo-path> [ref]
```

---

### `agb doctor`

Runs comprehensive environment diagnostics.

```bash
agb doctor
```

**Checked Items**:
- Node.js version (`>= 18`)
- `agy` CLI binary & authentication
- `@adlc/antigravity` plugin installation & contract version
- `adlc` CLI binary
- macOS `sandbox-exec` / Linux `bwrap`
- Brain directory existence
- ADLC Ticket Store integrity (`.adlc/tickets/`)

---

### `agb status`

Displays execution progress for an active or completed run.

```bash
agb status <repo-path> [--watch] [--interval <ms>]
```

- `--watch`: Refreshes status display live.
- `--interval <ms>`: Refresh rate in milliseconds (default: `1000ms`).

---

### `agb sidecar`

Launches the native web dashboard sidecar server.

```bash
agb sidecar <repo-path> [--port <port>]
```

- Default Port: `3333` (or `AGB_SIDECAR_PORT` / `ANTIGRAVITY_SIDECAR_WEB_PORT`).
- Writes token with `0o600` permissions to `.booster/token`.

---

### `agb probe`

Measures quota pool latency and concurrency limits.

```bash
agb probe <concurrencies> [model]
```

- Example: `agb probe 2,4,8 gemini-flash`

---

## 4. Schemas & Configuration Formats

### `plan.json` Schema

```json
{
  "repo": "/abs/path/to/target-repo",
  "base": "main",
  "gate": {
    "build": "npm run typecheck",
    "test": "npm test"
  },
  "prosecution": {
    "dryPasses": 1
  },
  "source": {
    "type": "antigravity-brain",
    "id": "conv-12345",
    "title": "Add Auth System"
  },
  "tickets": [
    {
      "id": "T1",
      "title": "Create User Data Model",
      "body": "Create lib/user.mjs with User class, validateEmail, and hashing functions. Include unit tests in test/user.test.mjs.",
      "scope": ["lib/user.mjs", "test/user.test.mjs"],
      "rails": ["lib/contracts/**"],
      "edges": [{ "to": "T2" }],
      "tier": "cheap",
      "pool_hint": "gemini"
    },
    {
      "id": "T2",
      "title": "Create Authentication Controller",
      "body": "Implement AuthController in lib/auth.mjs using T1 user model.",
      "scope": ["lib/auth.mjs", "test/auth.test.mjs"],
      "rails": ["lib/contracts/**"],
      "edges": [],
      "tier": "mid",
      "pool_hint": "auto"
    }
  ]
}
```

### Ticket Field Rules

- **`id`**: Unique string identifier (`"T1"`).
- **`body`**: Self-contained instructions. Builder sees ONLY this body plus the repo.
- **`scope`**: Array of allowed globs. Modifications outside scope fail the strike.
- **`rails`**: Array of read-only globs. Editing a rail fails the ticket.
- **`edges`**: Dependency edges (`{"to": "T2"}`). `T1` blocks `T2`.
- **`tier`**: Execution tier (`cheap`, `mid`, `frontier`).
- **`pool_hint`**: Quota pool preference (`gemini`, `claude`, `auto`).

---

## 5. Environment Variables Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `AGB_PROVIDER` | `agy` | Execution provider mode (`agy` for standard CLI, `jetski` for JetSki `agentapi` subagents). |
| `AGB_BUILD_TIMEOUT` | `5m` | Worker execution timeout (excess burns a strike). |
| `AGB_SANDBOX_GATES` | `1` (macOS) | Enforces Seatbelt / `bwrap` sandboxing for gates. Set to `0` inside disposable containers. |
| `AGB_ALLOW_DIRTY` | `0` | Set `1` to allow running on dirty git repos. *Warning: Rollbacks use `git reset --hard`.* |
| `AGB_AGY_BIN` | `agy` | Custom path to `agy` binary. |
| `AGB_ADLC_BIN` | `adlc` | Custom path to `adlc` binary. |
| `ADLC_ANTIGRAVITY_PLUGIN_PATH` | auto | Resolved path to `@adlc/antigravity` plugin package. |
| `AGB_PLUGIN_DIR` | `~/.gemini/config/plugins/adlc-antigravity` | Path to installed adlc-antigravity plugin directory. |
| `AGB_BRAIN_DIR` | `~/.gemini/antigravity/brain` | Directory containing Antigravity plan artifacts. |
| `ADLC_PROVIDER` | — | Set `agy` to route `@adlc` package executions through Antigravity credentials. |

---

## 6. JetSki Environment Integration

To use `antigravity-booster` in JetSki:

1. **Bootstrap in JetSki**:
   ```bash
   agb bootstrap
   ```
2. **Enable JetSki Provider**:
   ```bash
   export AGB_PROVIDER=jetski
   ```
3. **Run Fleet Workloads**:
   ```bash
   agb run plan.json
   ```
4. **Verification**:
   Run `agb doctor` and `npm test` to verify subagent isolation and sandbox leak audit protections.
