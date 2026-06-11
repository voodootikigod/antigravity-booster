# Antigravity 2.0 — Platform Research (web, 2026-06-11)

Condensed from web research. Items marked UNVERIFIED have single-source or
conflicting evidence.

## Platform shape

Antigravity 2.0 (launched 2026-05-19, Google I/O) is a five-surface platform:
standalone agent-first desktop app, `agy` CLI, Python SDK, Managed Agents API
(per-run billing), Enterprise Agent Platform. The legacy VS Code-fork IDE
(with Agent Manager) remains available. CLI and desktop app share one agent
harness.

- **Agent Manager**: spawn/monitor/switch/archive agents across workspaces;
  Inbox tracks running conversations. One agent per workspace recommended.
- **Brain artifacts**: `~/.gemini/antigravity/brain/<conversation-uuid>/` —
  `implementation_plan.md`, `task.md`, `walkthrough.md`, transcripts in
  `.system_generated/logs/`. Plain markdown → readable by anything, including
  the orchestrator (hybrid-pipeline integration point).
- **Dynamic subagents** (v2): primary agent spawns parallel subagents with
  isolated contexts. A2A protocol supports up-to-16-agent configurations.
  Docs warn to cap subagent depth (recursion exhausts budgets).
- v2 commands: `/goal` (run to completion), `/grill-me`, `/agent` (async
  subagent), `/schedule` (cron), `/btw`, `/export` (CLI → desktop), `/usage`
  (quota), JSON hooks (pre-tool, post-edit, session-start).

## THE QUOTA REALITY (kills the "infinite tokens" premise)

- Free: ~20 agent requests/day. AI Pro ($20): ~100/day, **weekly** refresh
  since Mar 2026 — overrun → lockout up to 7 days. Ultra $100 (≈5× Pro),
  Ultra Premium $200 (≈20× Pro, "no weekly cap").
- **Per-model quota pools are separate**: Gemini Flash, Gemini Pro, Claude,
  image gen each independent. Exhausting Gemini does not touch Claude.
  → Design consequence: route across pools; cross-pool concurrency verified
  locally (see calibration).
- Overage credits $0.01 each; credit-per-request conversion undocumented
  ("ghost-drains" complaint).
- Top community complaint: background agent loops burning a week's quota;
  agents re-reading files instead of caching; whole-file regeneration.
- Quota visibility: `/usage` (interactive); community tool "Antigravity
  Cockpit" (VS Code ext) reads per-model quota.

→ **Booster design consequences**: token/request accounting per run; per-pool
concurrency + budget ceilings; prefer diffs over whole-file regeneration in
charters; idempotent scheduled tasks (double-fire reports exist); never leave
loops unattended without budgets (ADLC Principle 8 already requires this).

## Known issues

- Model label in UI may not match model actually called (UNVERIFIED).
- Sandbox macOS-only. Linux CLI preview-quality.
- Scheduled tasks can double-fire — design idempotent.
- Routing errors: prompt sent to wrong agent tab.

## Existing orchestration ecosystem (don't reinvent blindly)

- **oh-my-antigravity (omagy)**: agy plugin — interview/PRD planning skills,
  checkpointed execution, `omagy team` parallel coordination with JSON status.
  Overlap with booster: team mode. Differentiation: booster is gate-shaped
  (ADLC), quota-pool-aware, cross-model prosecution, deterministic
  orchestrator (no model-as-scheduler).
- **Antigravity Cockpit**: quota dashboards, auto wake-up reset scheduling.
- **antigravity-awesome-skills**, **AgentKit 2.0** (16 specialist agents —
  UNVERIFIED if official).

## Source URLs

- https://antigravity.google/blog/introducing-google-antigravity-2-0
- https://antigravity.google/docs/cli-getting-started
- https://github.com/google-antigravity/antigravity-cli (CHANGELOG, releases)
- https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- https://9to5google.com/2026/05/21/google-has-tripled-gemini-usage-limits-for-antigravity-twice/
- https://aicodingtools.im/limits
- https://discuss.ai.google.dev/t/antigravity-2-0-used-an-entire-weeks-quota-on-two-simple-uis/169828
- https://github.com/shayne-snap/oh-my-antigravity
- https://agentpedia.codes/blog/antigravity-agent-orchestration-multi-agent
- https://medium.com/google-cloud/getting-started-with-antigravity-2-0-updated-8a953f079f97
