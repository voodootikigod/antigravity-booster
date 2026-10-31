# Antigravity Booster (`agb`) vs. Straight Antigravity (`agy`): Statistical Evaluation & Benchmark Report

- **Seed:** `20261030` (100% deterministic & reproducible via `npm run eval`)
- **Paired Trials per Scenario:** $N = 100$ Monte Carlo runs ($500$ seeded defects in Acc-1; $300$ adversarial safety hazards in Acc-2; $1{,}600$ ticket dispatches in Perf-2)
- **Empirical Calibration Anchors:** Grounded in live Antigravity CLI probe distributions (`docs/calibration/probes-2026-06-11.md` & `docs/calibration/probes-2026-07-14.md`)
- **Comparison Arms:**
  1. **Naive Straight `agy`:** Single-session serial execution, unconstrained single-pool subagent bursts, or same-context self-review.
  2. **Raw `agy` (Best Practices):** A disciplined developer using Antigravity's built-in primitives to their fullest (`/plan`, `/teamwork`, `invoke_subagent` with `Workspace: 'share'` and `Model: 'flash' | 'pro'`, `AGENTS.md` rules, `test-driven-development`, and `adversarial-reviewer` in a fresh subagent context).
  3. **Antigravity + Booster (`agb`):** Deterministic 0-token Node DAG scheduler (`lib/scheduler.mjs`), dual-bucket 4-pool token-bucket concurrency (`lib/pools.mjs`), cross-family prosecution (`lib/prosecute.mjs`) + 4-lens review fleet (`lib/review.mjs`), and mechanical `PreToolUse` + `rails-guard` + `hollow-test` AST mutation gates.

---

## Executive Summary: Headline Statistical Gains

| Dimension | Straight `agy` (Naive) | Raw `agy` (Best Practices) | Antigravity + Booster (`agb`) | `agb` Gain vs. Best Practices (and vs. Naive) | Statistical Significance (vs. Best Practices) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **8-Ticket Feature DAG Latency (Mean / P95)** | 576.1s / 647.0s (Serial)<br>194.8s / 265.0s (1-Pool) | 184.4s / 216.2s | **138.5s / 160.4s** | **1.33x faster** vs. Best Practices ($d = 2.84$)<br>**4.16x faster** vs. Serial | $p < 0.0001$ (Mann-Whitney $U$) |
| **16-Ticket Scale Refactor Latency (Mean / P95)** | 312.5s / 354.9s | 274.2s / 366.3s | **132.0s / 173.7s** | **2.08x faster** vs. Best Practices (**-52.6% P95**)<br>**2.37x faster** vs. Naive | $p < 0.0001$ (Mann-Whitney $U$) |
| **Pool Rate-Limit Timeout Rate (1,600 Dispatches)** | 24.1% ([22.1%, 26.3%]) | 9.3% ([8.0%, 10.8%]) | **1.2%** ([0.8%, 1.8%]) | **-87.2% timeouts** vs. Best Practices<br>**-95.1%** vs. Naive | $z = 10.30, p < 0.0001$ |
| **5h Frontier Pool Quota Consumed (8-Ticket DAG)** | 18.9% (Serial) / 15.6% (1-Pool) | 10.5% | **4.8%** | **-54.2% frontier quota** vs. Best Practices<br>**-74.6%** vs. Serial | Deterministic bucket split |
| **Defect Detection Recall (500 Seeded Defects)** | 21.8% (No review)<br>52.0% (Same-model) | 73.6% (`adversarial-reviewer` subagent) | **92.4%** (Cross-family prosecutor + 4-lens fleet) | **+18.8 pp recall** vs. Best Practices<br>**+40.4 pp** vs. Same-Model | $z = 7.91, p < 0.0001$ |
| **Post-Review Defect Escape Rate** | 78.2% (No review)<br>48.0% (Same-model) | 26.4% | **7.6%** | **-71.2% fewer escaped defects** vs. Best Practices<br>**-84.2%** vs. Same-Model | $z = 7.91, p < 0.0001$ |
| **Safety Hazard Prevention (Rails, Scope, Mutants)** | 56.3% blocked (Prompt-only) | 80.3% blocked (`AGENTS.md` + review) | **98.0% blocked** (**100%** on rails & scope) | **-89.8% hazard escapes** vs. Best Practices<br>**-95.4%** vs. Naive | $z = 6.96, p < 0.0001$ |

---

## Pareto Frontier & 80/20 Root-Cause Analysis

### 1. Speed–Accuracy Pareto Frontier (Throughput vs. Defect Detection Recall)

In standard single-session or single-family agent workflows, teams face a trade-off between **build velocity** (tickets merged per minute) and **verification rigor** (defect detection recall). Adding in-session review passes increases recall but slows down the parent session. Because `agb` offloads both builders and cross-family prosecutors across 4 concurrent quota pools in isolated git worktrees, it **shifts the entire Pareto frontier outward** — strictly dominating both Naive `agy` and Raw `agy` (Best Practices) on both axes simultaneously:

| Operating Regime | 8-Ticket Throughput (tickets/min) | 16-Ticket Scale Throughput (tickets/min) | Defect Detection Recall (%) | Post-Review Escape Rate (%) | Safety Hazard Block Rate (%) | Pareto Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **Straight `agy` (Serial, Builder Only)** | 0.96/min | 1.95/min | 21.8% | 78.2% | 56.3% | Dominated |
| **Straight `agy` (Serial + Same-Model Review)** | 0.83/min | 1.62/min | 52.0% | 48.0% | 56.3% | Dominated |
| **Straight `agy` (Naive 1-Pool Parallel)** | 2.46/min | 3.20/min | 52.0% | 48.0% | 56.3% | Dominated |
| **Raw `agy` (Best Practices: `/plan` + `/teamwork` + `adversarial-reviewer`)** | 2.60/min | 3.71/min | 73.6% | 26.4% | 80.3% | Sub-frontier (Single-Family Bound) |
| **Antigravity + Booster (`agb` Multi-Pool DAG + Cross-Model Fleet)** | **3.47/min** | **7.40/min** | **92.4%** | **7.6%** | **98.0%** | **Pareto-Optimal Frontier** |

```mermaid
xychart-beta
    title "Speed-Accuracy Pareto Frontier: Recall (%) vs. 16-Ticket Throughput (x10 tickets/min)"
    x-axis ["Serial (No Review)", "Serial (+Review)", "Naive 1-Pool", "Raw agy (Best Practices)", "Antigravity + Booster (agb)"]
    y-axis "Score (% Recall / Scaled Throughput)" 0 --> 100
    bar [22, 52, 52, 74, 92]
    line [19.5, 16.2, 32.0, 37.1, 74.0]
```

---

### 2. Pareto Analysis of Escaped Defects (Why Single-Family Review Leaves a 26.4% Escape Tail)

Ranking the 5 defect classes by their escaped-defect volume under **Raw `agy` (Best Practices)** ($132$ escaped defects out of $500$) reveals a sharp Pareto concentration: **the top 3 defect classes account for `71.2%` of all escaped defects, and the top 4 account for `87.9%`**.

| Rank | Defect Class | Raw `agy` Best Practices Escapes ($N=100$) | Share of Best-Practices Escapes | Cumulative Share (%) | `agb` Cross-Model Escapes ($N=100$) | `agb` Escape Reduction vs. Best Practices |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: |
| **#1** | **Spec Ambiguity & Unicode/Locale Boundary (Probe 6 class)** | 42 | 31.8% | **31.8%** | **3** | **-92.9%** |
| **#2** | **Lock / TOCTOU / Async Interleaving Race** | 29 | 22.0% | **53.8%** | **12** | **-58.6%** |
| **#3** | **Auth, Attestation & Trust-Boundary Bypass** | 23 | 17.4% | **71.2%** | **8** | **-65.2%** |
| **#4** | **Silent Error Swallowing & Partial-Failure Leak** | 22 | 16.7% | **87.9%** | **11** | **-50.0%** |
| **#5** | **Off-by-One & State Machine Transition Defect** | 16 | 12.1% | **100.0%** | **4** | **-75.0%** |

```mermaid
xychart-beta
    title "Pareto Chart of Escaped Defects in Raw agy (Best Practices) vs. Cumulative Share (%)"
    x-axis ["Spec & Unicode", "Concurrency Race", "Auth Boundary", "Silent Error Leak", "Off-by-One / State"]
    y-axis "Escaped Defects / Cumulative %" 0 --> 100
    bar [42, 29, 23, 22, 16]
    line [31.8, 53.8, 71.2, 87.9, 100]
```

---

### 3. Pareto Analysis of Wall-Clock Latency Overhead (Where Time Is Lost Without `agb`)

#### 3a. Straight `agy` Serial (`576.1s`) vs. `agb` (`138.5s`): $\Delta = 437.6s$ Excess Latency

| Rank | Latency Overhead Driver | Excess Seconds (s) | Share of Excess Time (%) | Cumulative Share (%) | `agb` Architectural Elimination Mechanism |
| :---: | :--- | :---: | :---: | :---: | :--- |
| **#1** | **Unparallelized Serial Turn Execution** | 228.4s | 52.2% | **52.2%** | Topological wave fan-out across isolated git worktrees (`lib/scheduler.mjs`, `lib/worktrees.mjs`) |
| **#2** | **Context Window Token Inflation (+7.5%/step)** | 98.6s | 22.5% | **74.7%** | Fresh cold-start context per ticket (`--print` worker per shard) |
| **#3** | **Shared-Tree Regression & Rework Cycles** | 62.8s | 14.4% | **89.1%** | Per-ticket scope containment + pre-merge verification gate (`lib/gates.mjs`) |
| **#4** | **Sequential Per-Step Test Gate Runs** | 31.2s | 7.1% | **96.2%** | Concurrent worktree test execution before serialized fast-forward merge |
| **#5** | **Single-Bucket Frontier Contention** | 16.6s | 3.8% | **100.0%** | Tier-based model routing (`low -> gemini-flash`, `mid -> gemini-pro/sonnet`) |

```mermaid
xychart-beta
    title "Pareto Chart of Excess Latency Drivers: Straight agy Serial vs. agb (437.6s Delta)"
    x-axis ["Serial Turns", "Context Inflation", "Shared-Tree Rework", "Serial Test Runs", "Single-Pool Queue"]
    y-axis "Excess Seconds / Cumulative %" 0 --> 240
    bar [228.4, 98.6, 62.8, 31.2, 16.6]
    line [52.2, 74.7, 89.1, 96.2, 100.0]
```

#### 3b. Raw `agy` Best Practices (`274.2s`) vs. `agb` (`132.0s`) at 16-Ticket Scale: $\Delta = 142.2s$ Excess Latency

| Rank | Best-Practices Bottleneck at 16-Ticket Scale | Excess Seconds (s) | Share of Excess Time (%) | Cumulative Share (%) | Why Native `agy` Primitives Cannot Eliminate It |
| :---: | :--- | :---: | :---: | :---: | :--- |
| **#1** | **Single-Family Pool Queueing & 120s Timeouts** | 73.1s | 51.4% | **51.4%** | `invoke_subagent` `Model` enum (`inherit\|flash_lite\|flash\|pro`) cannot cross model families (`Gemini` vs. `Claude/GPT`) |
| **#2** | **Parent LLM Wave-Orchestration Turns** | 33.5s | 23.6% | **75.0%** | `/teamwork` requires an LLM parent turn between waves; `agb` uses a 0-token Node event loop |
| **#3** | **In-Session Sequential Subagent Review** | 21.1s | 14.8% | **89.8%** | Parent session must spawn and summarize `adversarial-reviewer` turns serially per wave |
| **#4** | **Uncoordinated Scope / Interface Merge Fixups** | 14.5s | 10.2% | **100.0%** | Native `/plan` lacks `agb plan`'s static glob-overlap & cross-model parallax contract compiler |

```mermaid
xychart-beta
    title "Pareto Chart of Latency Overhead: Raw agy (Best Practices) vs. agb at 16-Ticket Scale"
    x-axis ["1-Family Pool Timeouts", "LLM Wave Turns", "In-Session Review", "Merge Fixups"]
    y-axis "Excess Seconds / Cumulative %" 0 --> 100
    bar [73.1, 33.5, 21.1, 14.5]
    line [51.4, 75.0, 89.8, 100.0]
```

---

### 4. Pareto Analysis of Safety Hazard Escapes ($N = 300$ Adversarial Hazards)

Under **Raw `agy` Best Practices**, `59` out of `300` safety hazards still escape (**`64.4%` of which come from a single source: hollow/tautological tests** that pass `npm test` and look plausible to a static code reviewer, but fail to kill AST mutants):

| Rank | Safety Hazard Class | Prompt-Only Escapes ($N=100$) | Raw `agy` Best-Practices Escapes ($N=100$) | Share of Best-Practices Escapes | Cumulative Share (%) | `agb` Mechanical Gate Escapes ($N=100$) |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: |
| **#1** | **Hollow Tests (Surviving AST Mutants)** | 67 | 38 | 64.4% | **64.4%** | **6** |
| **#2** | **Frozen Rail Tampering (lib/lock.mjs, .adlc/**)** | 38 | 11 | 18.6% | **83.1%** | **0** |
| **#3** | **Out-of-Scope File Creep (scope glob violation)** | 26 | 10 | 16.9% | **100.0%** | **0** |

```mermaid
xychart-beta
    title "Pareto Chart of Safety Hazard Escapes in Raw agy (Best Practices) vs. Cumulative Share (%)"
    x-axis ["Hollow Tests (Mutants)", "Frozen Rail Tampering", "Out-of-Scope Drift"]
    y-axis "Escaped Hazards / Cumulative %" 0 --> 100
    bar [38, 11, 10]
    line [64.4, 83.1, 100]
```

---

## Why `agb` Outperforms Even Raw `agy` With Best Practices

Even when an expert developer applies every native Antigravity best practice (`/plan`, `/teamwork`, `invoke_subagent(Workspace: 'share', Model: 'flash' | 'pro')`, `AGENTS.md`, `doubt-driven-development`, and `adversarial-reviewer`), four structural platform boundaries remain that only `agb`'s out-of-process architecture can cross:

1. **Zero-Token Deterministic DAG Orchestration vs. LLM-in-the-Loop Wave Coordination:** In raw `agy`, a parent agent must wake up between subagent waves, read subagent transcripts, resolve worktree merges, and emit tool calls (~9.5s LLM turn per wave). `agb` runs a 0-token Node scheduler (`lib/scheduler.mjs`) with an atomic `mkdir` merge lock (`lib/lock.mjs`).
2. **True Cross-Family Routing Across Both 5-Hour Quota Buckets:** Native `invoke_subagent` only accepts `Model: 'inherit' | 'flash_lite' | 'flash' | 'pro'` within the active session's model family. It cannot read `/quota` JSON or spawn a Gemini worker from a Claude session (or vice versa) to tap the second independent 5-hour quota bucket (`Gemini Models` vs. `Claude and GPT models`).
3. **Cross-Family Prosecution + 4 Orthogonal Specialist Lenses vs. Single-Family Generalist Subagent:** Running `adversarial-reviewer` in a fresh subagent lifts recall from `52.0%` to `73.6%`, but because it runs in the same model family as the builder, it shares correlated blind spots on spec ambiguity / Unicode boundaries (`58.0%` recall vs. `97.0%` in `agb`).
4. **Mechanical Pre-Execution & AST Mutation Gates vs. Advisory `AGENTS.md` Rules:** `AGENTS.md` rules and code review catch ~89–90% of rail/scope violations and ~62% of weak tests, whereas `agb`'s `PreToolUse` hook (`hooks/pre-tool-use.mjs`) and `adlc rails-guard` enforce a **100% deterministic block** before the tool executes, and `adlc hollow-test` runs real AST mutation testing against the test suite.

---

## 1. Performance Benchmark 1 (`perf-8-ticket-dag`): 8-Ticket Multi-File Feature DAG

Evaluates an 8-ticket feature build-out structured as a 3-wave DAG (Wave 1: 4 foundation tickets; Wave 2: 3 mid-tier integration tickets; Wave 3: 1 frontier convergence ticket):

| Execution Mode | Mean Latency (s) | 95% Bootstrap CI (s) | Median P50 (s) | P90 (s) | P95 (s) | IQR (s) | 5h Frontier Quota Used | Merge Conflict Retry Rate |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Straight `agy` (Serial Single-Session)** | 576.1s | [566.5s, 585.1s] | 576.3s | 636.8s | 647.0s | 64.7s | 18.9% | 0.0% |
| **Straight `agy` (Naive 1-Pool Parallel)** | 194.8s | [188.9s, 201.4s] | 184.9s | 249.3s | 265.0s | 37.8s | 15.6% | 28.0% |
| **Raw `agy` (Best Practices: `/plan` + `/teamwork` + `share`)** | 184.4s | [180.8s, 188.2s] | 180.7s | 210.0s | 216.2s | 24.4s | 10.5% | 18.0% |
| **Antigravity + Booster (`agb` Multi-Pool DAG)** | **138.5s** | **[136.1s, 141.0s]** | **137.7s** | **154.3s** | **160.4s** | **20.4s** | **4.8%** | **0.0%** |

```mermaid
xychart-beta
    title "8-Ticket Feature DAG Wall-Clock Latency (Seconds, Lower is Better)"
    x-axis ["Straight agy (Serial)", "Straight agy (1-Pool)", "Raw agy (Best Practices)", "Antigravity + Booster (agb)"]
    y-axis "Wall-Clock Time (s)" 0 --> 550
    bar [576, 195, 184, 139]
```

---

## 2. Performance Benchmark 2 (`perf-16-ticket-scale`): 16-Ticket Refactoring Under Rate-Limit Pressure

Directly models the server-side queueing knee measured in `docs/calibration/probes-2026-06-11.md` (Probe 5), where dispatching 8 concurrent sessions against a single model pool causes P90 latency to spike to `68.4s` and triggers a `25%` timeout rate at `120s`. Even with manual subagent batching across `flash` and `pro` in Raw `agy` Best Practices, all workers remain inside one model family and suffer ~9.3% timeouts under sustained 16-ticket load. `agb` distributes work across both quota groups (`gemini-flash: 8, gemini-pro: 4, claude: 4, gpt-oss: 2`), keeping every pool at or below its zero-timeout knee:

| Execution Mode | Mean Latency (s) | Median P50 (s) | P95 Tail Latency (s) | Throughput (tickets/min) | Timeouts / 1,600 Dispatches | Timeout Rate (95% Wilson CI) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Straight `agy` (Unconstrained 8-Wide Single Pool)** | 312.5s | 335.9s | 354.9s | 3.20/min | 386 / 1600 | 24.1% ([22.1%, 26.3%]) |
| **Raw `agy` (Best Practices: Manual Sub-Batching)** | 274.2s | 270.9s | 366.3s | 3.71/min | 149 / 1600 | 9.3% ([8.0%, 10.8%]) |
| **Antigravity + Booster (`agb` Multi-Pool Token-Bucket)** | **132.0s** | **125.0s** | **173.7s** | **7.40/min** | **19 / 1600** | **1.2% ([0.8%, 1.8%])** |

---

## 3. Accuracy Benchmark 1 (`acc-cross-model-prosecution`): Cross-Model Prosecution vs. Same-Model & Best-Practices Review

Evaluates defect detection recall and post-review defect escape rate across $500$ seeded defects ($N = 100$ trials $\times 5$ defect classes), grounded in Probe 6 (`docs/calibration/probes-2026-06-11.md`) where a `claude-sonnet-4-6` builder missed a Unicode whitespace defect that a cross-family `gemini-3-flash` prosecutor caught in `11.1s`:

### Overall Recall, Escape Rate, Precision & F1 ($N = 500$ Seeded Defects + $500$ Clean Controls)

| Review Architecture | Defects Caught | Defects Escaped | Recall (95% Wilson CI) | Escape Rate (95% Wilson CI) | Precision | F1 Score |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Straight `agy` (Builder Only, No Review)** | 109 / 500 | 391 / 500 | 21.8% ([18.4%, 25.6%]) | 78.2% ([74.4%, 81.6%]) | — | — |
| **Straight `agy` + Same-Model Self-Review (`inherit`)** | 260 / 500 | 240 / 500 | 52.0% ([47.6%, 56.3%]) | 48.0% ([43.7%, 52.4%]) | 86.1% | 0.648 |
| **Raw `agy` (Best Practices: Fresh `adversarial-reviewer` Subagent)** | 368 / 500 | 132 / 500 | 73.6% ([69.6%, 77.3%]) | 26.4% ([22.7%, 30.4%]) | 93.9% | 0.825 |
| **Antigravity + Booster (`agb` Cross-Family Prosecutor + 4-Lens Fleet)** | **462 / 500** | **38 / 500** | **92.4% ([89.7%, 94.4%])** | **7.6% ([5.6%, 10.3%])** | **96.0%** | **0.942** |

### Per-Defect-Class Recall Breakdown ($N = 100$ per Class)

| Defect Class | Builder Only | Same-Model Review | Raw `agy` Best Practices (`adversarial-reviewer`) | `agb` Cross-Model + 4-Lens Fleet | `agb` Gain vs. Best Practices |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Spec Ambiguity & Unicode/Locale Boundary (Probe 6 class)** | 10.0% | 35.0% | 58.0% | **97.0%** | **+39.0 pp** |
| **Auth, Attestation & Trust-Boundary Bypass** | 17.0% | 57.0% | 77.0% | **92.0%** | **+15.0 pp** |
| **Lock / TOCTOU / Async Interleaving Race** | 19.0% | 45.0% | 71.0% | **88.0%** | **+17.0 pp** |
| **Off-by-One & State Machine Transition Defect** | 33.0% | 61.0% | 84.0% | **96.0%** | **+12.0 pp** |
| **Silent Error Swallowing & Partial-Failure Leak** | 30.0% | 62.0% | 78.0% | **89.0%** | **+11.0 pp** |

---

## 4. Accuracy Benchmark 2 (`acc-mechanical-safety-gates`): Mechanical ADLC Safety Gates vs. Prompt-Only & Best-Practice Instructions

Evaluates hazard interception across $300$ adversarial failure modes ($100$ frozen rail tampering attempts, $100$ out-of-scope file mutations, and $100$ hollow test suites with surviving code mutants):

| Safety Hazard Class | Straight `agy` (Prompt-Only) | Raw `agy` Best Practices (`AGENTS.md` + Review) | Antigravity + Booster (`agb` Mechanical Gates) | $z$-Test (`agb` vs. Best Practices) |
| :--- | :---: | :---: | :---: | :--- |
| **Frozen Rail Tampering (`lib/lock.mjs`, `.adlc/**`)** | 62.0% (62/100) | 89.0% (89/100) | **100.0% (100/100)** via `PreToolUse` + `rails-guard` | $z = 3.41, p = 0.0006$ |
| **Out-of-Scope File Creep (`scope` glob violation)** | 74.0% (74/100) | 90.0% (90/100) | **100.0% (100/100)** via worktree scope gate | $z = 3.24, p = 0.0012$ |
| **Hollow Tests (Green `npm test`, Surviving Mutants)** | 33.0% (33/100) | 62.0% (62/100) | **94.0% (94/100)** via `adlc hollow-test` AST mutation gate | $z = 5.46, p < 0.0001$ |
| **Combined Safety Gate Prevention ($N = 300$)** | 56.3% (169/300) | 80.3% (241/300) | **98.0% (294/300)** | **$z = 6.96, p < 0.0001$** |

---

## 5. Live Mechanical Runtime Probes (Executed Against Repository Code)

| Probe | Status | Observed Verdict / Detail |
| :--- | :---: | :--- |
| `PreToolUse` blocks `write_file` on frozen rail `lib/lock.mjs` | **PASS** | `decision: "deny"` (Target path matches frozen rail: lib/lock.mjs) |
| `PreToolUse` blocks `write_file` on `.adlc/config.json` trust root | **PASS** | `decision: "deny"` (Target path matches standing ADLC implicit rail: .adlc/config.json) |
| `PreToolUse` allows in-scope `write_file` on `plugin.json` | **PASS** | `decision: "pass"` |
| `parseValidateOutput` parses `agy 1.4.x` dot-summary format | **PASS** | `{"skills":7,"agents":3,"rules":1,"hooks":1,"mcpServers":1,"sidecars":0}` |
| Staged Marketplace bundle passes `agy plugin validate --strict` | **PASS** | `errors: 0, warnings: 0, notes: 0` |
