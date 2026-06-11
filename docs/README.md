# Antigravity Booster Documentation

Welcome to the documentation for **antigravity-booster** (`agb`). This tool implements the ADLC (Agentic Software Development Lifecycle) on top of Google Antigravity 2.0 (`agy`), enabling massive, parallel, and disciplined agentic code build-outs.

## Table of Contents

| Section | Description |
| :--- | :--- |
| 🚀 **[CLI Usage & Configuration](usage.md)** | Full guide to commands, schemas (`plan.json` and `sweep.json`), environment variables, and running runs. |
| 🛡️ **[Guidelines & Doctrine](guidelines.md)** | Core principles, the ADLC doctrine (P0-P7), cross-model prosecution flow, sandboxing, and execution gates. |
| 📊 **[Calibration Probes](calibration/probes-2026-06-11.md)** | Empirical measurements of latency, concurrency curves, and Seatbelt sandbox safety profiles. |
| 🔍 **[Research & Platform Discovery](research/)** | Analysis of the Antigravity CLI and GUI limits, capabilities, and platform quirks. |

---

## Architecture Overview

Antigravity Booster is organized in a 4-layered architecture:

```mermaid
graph TD
    subgraph L4 [L4: Hybrid GUI Plan Ingestion]
        Plan[GUI Brain Artifact / plan.json]
    end
    subgraph L3 [L3: Recursive Orchestration]
        SelfOrch[adlc-self-orchestrate Skill]
    end
    subgraph L2 [L2: Orchestration Engine]
        AgbCli[agb CLI] --> Scheduler[DAG Scheduler]
        Scheduler --> Pools[Quota Pools & Semaphores]
        Scheduler --> Worktrees[Worktree Manager]
        Scheduler --> Gates[Seatbelt Gates]
        Scheduler --> Prosecute[Cross-Model Prosecution]
    end
    subgraph L1 [L1: Standard Configuration]
        Skills[ADLC Skills & Charters]
    end

    Plan --> AgbCli
    SelfOrch --> AgbCli
    AgbCli --> L1
```

- **L1 Config**: Skills, charters, and `AGENTS.md` templates installed into `~/.gemini/` that improve any standalone `agy` session.
- **L2 Engine**: The `agb` CLI and scheduler that orchestrates worktrees, runs sandboxed verification, manages concurrency, and drives cross-family model reviews.
- **L3 Recursive**: Agent skills that teach a top-level agent how to decompose tasks and drive the `agb` fleet.
- **L4 Hybrid**: Exposes tools to convert high-level plans generated in the Antigravity GUI desktop app into a ticket DAG.

## Quick Reference

- **To run a ticket plan:**
  ```bash
  agb validate plan.json
  agb preflight plan.json
  agb run plan.json
  ```
- **To inspect a live run:**
  ```bash
  agb status /path/to/target-repo
  ```
- **To run a cheap-tier fanout sweep:**
  ```bash
  agb sweep sweep.json
  ```
- **To run read-only codebase reviews:**
  ```bash
  agb review /repo
  ```
