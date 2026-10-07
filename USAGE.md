# Antigravity Booster Usage Guide

`antigravity-booster` (`agb`) orchestrates **Google Antigravity** (`agy` CLI) for large, parallel, disciplined software build-outs.

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
  - **Antigravity CLI**: [`agy`](lib/agy.mjs) (`>= 1.2.8`) installed and authenticated on `PATH`.
  - **ADLC Runtime**: [`@adlc/cli`](node_modules/@adlc/cli/bin/adlc.mjs) (`>= 1.11.1`) installed or resolvable.

### 1. Installation

Install the native Antigravity plugin from git (recommended). Nothing needs `npm install`: the runtime is prebuilt under `dist/` and `vendor/`.

```bash
agy plugin install https://github.com/voodootikigod/antigravity-booster.git
```

The npm package remains a secondary channel (`npm install -g antigravity-booster`, or `npm link` from a clone). To move an npm-global or checkout install onto the plugin, use [`agb migrate`](#agb-migrate).

### 2. Bootstrapping

The terminal shim does not exist until the first bootstrap, so run that once from a terminal:

```bash
/bin/sh "$HOME/.gemini/config/plugins/antigravity-booster/bin/node-launcher.sh" dist/agb.mjs bootstrap
```

[`agb bootstrap`](lib/bootstrap.mjs) installs the integrity-pinned `adlc-antigravity` plugin and writes `~/.local/bin/agb`. After that, use `agb …` from a terminal or the slash commands inside Antigravity.

**How slash commands run.** Antigravity converts `commands/*.md` into instructions for the model rather than executing them. Each `/agb-*` command tells the model to run `~/.local/bin/agb <subcommand>` with your arguments, so it goes through the same policy guard as any other shell command (`ask` in an interactive session in a repo with active rails, pass-through elsewhere).

**Residual risk in print mode.** In user-launched `agy -p` sessions Antigravity turns `ask` into allow. Booster's in-session protection there is deny-only: frozen-rail and protected-root denials still hold, but commands that would have asked are run. `agb run` marks its own workers (`AGB_WORKER_TICKET` / `AGB_WORKER_MODE`), so they get deny instead of ask. The merge-time `adlc rails-guard` remains the backstop.

### 3. Diagnostic Health Check

Run [`agb doctor`](lib/doctor.mjs) to verify your tools, quota pools, and sandbox setup:

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

### `agb migrate`

Moves an npm-global or checkout install onto the native plugin, with a snapshot you can always roll back to.

```bash
agb migrate [--force]
agb migrate --rollback [--force-rollback]
agb migrate --break-lock [--force]
```

Migration runs in resumable steps, recorded in `~/.gemini/antigravity-cli/plugin_data/antigravity-booster/migration-state.json`:

1. **Snapshot**: copies the staged `antigravity-booster` and `adlc-antigravity` plugins (excluding `node_modules/`, `.worktrees/` and `.git/`; a plugin still over 100 MB is refused), the existing `~/.local/bin/agb`, the plugins' `import_manifest.json` entries and every `~/.gemini/skills` symlink. The first run also writes a read-only `pre-migration.baseline.json`, which later runs never change.
2. **Record links**: notes which skill links point into booster or adlc-antigravity (the npm package, a booster checkout's `skills/`, `@adlc/antigravity`, or the staged plugins). Links to your own skills are never touched.
3. **Stage**: installs both plugins and checks them with `agy plugin validate` and `import_manifest.json`. A failure stops here with nothing unlinked.
4. **Finish**: removes the recorded links, writes the terminal shim and records digests of the staged plugins.

Re-running after an interruption continues from the last completed step. After a completed migration, `--force` re-runs it; the original baseline is kept.

`--rollback` restores the pre-migration baseline: plugins, terminal shim, import entries and skill links (a link whose target no longer exists is skipped with a notice). If the staged plugins changed since migration, it refuses unless you pass `--force-rollback`. If booster was not installed before migration, a detached uninstaller removes it after rollback, and you are warned if no `agb` will remain on your `PATH`.

Both directions take a user-wide lock. A lock left behind by a process that died is reclaimed automatically; a wedged one can be cleared with `--break-lock` (asks for confirmation unless `--force`).

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
- Enforces sandboxed gates ([`lib/gates.mjs`](lib/gates.mjs)) using macOS Seatbelt, Linux Bubblewrap (`bwrap`), or Windows AppContainer.
- Runs cross-family refute-charter prosecution ([`lib/prosecute.mjs`](lib/prosecute.mjs)).
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
- Node.js version (`>= 22.19.0`)
- `agy` CLI binary (`>= 1.2.8`) & authentication
- `@adlc/antigravity` plugin installation & contract version handshake
- `@adlc/cli` binary (`>= 1.11.1`) with SHA-256 pinning & approved cache permissions (`~/.adlc/pinned/`)
- `adlc ticket doctor` syntax & DAG consistency check
- Platform sandboxing: macOS `sandbox-exec`, Linux `bwrap` usability probe (read-only root, credential masking), or Windows AppContainer active differential syscall probing and nonce attestation
- Quota pool availability across Gemini Flash, Gemini Pro, and Claude
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
| `AGB_PROVIDER` | `agy` | Execution provider mode (defaults to `agy`). |
| `AGB_BUILD_TIMEOUT` | `5m` | Worker execution timeout (excess burns a strike). |
| `AGB_SANDBOX_GATES` | sandbox on | `0` runs gates unsandboxed. Darwin uses Seatbelt; Linux uses Bubblewrap (`bwrap`); Windows uses AppContainer. |
| `AGB_EXEC_CACHE_DIR` | `~/.adlc/pinned/` | Directory where immutable pinned executables are staged outside restricted `noexec` temporary directories. |
| `AGB_STREAM_TIMEOUT` | `30000` (30s) | Subprocess streaming idle watchdog timeout in milliseconds. |
| `AGB_STREAM_LINE_CAP` | `1048576` (1MB) | Maximum line length for `stream-json` parser before truncation/error. |
| `AGB_STREAM_TOTAL_CAP` | `10485760` (10MB)| Total stream byte cap across subprocess lifetime. |
| `AGB_ALLOW_DIRTY` | `0` | Set `1` to allow running on dirty git repos. *Warning: Rollbacks use `git reset --hard`.* |
| `AGB_AGY_BIN` | `agy` | Custom path to `agy` binary. |
| `AGB_ADLC_BIN` | `adlc` | Custom path to `adlc` binary. |
| `ADLC_ANTIGRAVITY_PLUGIN_PATH` | auto | Resolved path to `@adlc/antigravity` plugin package. |
| `AGB_PLUGIN_DIR` | `~/.gemini/config/plugins/adlc-antigravity` | Path to installed adlc-antigravity plugin directory. |
| `AGB_BRAIN_DIR` | `~/.gemini/antigravity/brain` | Directory containing Antigravity plan artifacts. |
| `ADLC_PROVIDER` | — | Set `agy` to route `@adlc` package executions through Antigravity credentials. |

---

## 6. Antigravity Booster (`agb`) vs. Built-in `/boost`

Google Antigravity 2.0 provides the built-in [`/boost` slash command](https://antigravity.google/docs/boost/) for interactive multi-agent reasoning. The table below outlines how `agb` relates to `/boost`:

| Dimension | Built-in `/boost` Command | Antigravity Booster (`agb`) |
| :--- | :--- | :--- |
| **Primary Use Case** | Interactive, on-demand reasoning for difficult coding problems during an active session (debugging, tricky algorithms, single-file refactoring). | Autonomous, multi-hour execution of large architectural specifications and multi-ticket roadmaps across git worktrees. |
| **Execution Surface** | Internal to the Antigravity GUI or `agy` chat session. | External Node.js CLI daemon driving parallel `agy` subprocesses. |
| **Workspace Model** | Shared working directory with in-memory subagent context isolation. | Physical `git worktree` isolation per ticket (`.worktrees/agb-<id>`) with automated rebase and rollback. |
| **Sandboxing** | Standard interactive user permission prompts. | OS-level kernel isolation (Linux `bwrap` with read-only root and masked credentials, macOS Seatbelt, Windows AppContainer with differential probing). |
| **Quota Management** | Single interactive quota session. | Dual-pool quota routing across Gemini Flash, Gemini Pro, and Claude with token-bucket metering and admission controls. |
| **Lifecycle & Governance**| Single-turn or iterative conversation flow. | Full ADLC (P0–P6) ticket store, frozen machine rails (`rails-guard`), mutation testing (`hollow-test`), and cross-family prosecution (`agb review`). |

