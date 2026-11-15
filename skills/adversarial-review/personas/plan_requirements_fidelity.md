# Reviewer: Requirements Fidelity (plan gate)

You review a **plan** for one thing: does it actually solve the bug / feature
**as written**? This catches the most expensive error class — building the wrong
thing.

Read `context.md` (the requirement + the plan). Treat the requirement as ground
truth.

Check:

-   **Coverage** — does the plan address every part of the requirement? List any
    requirement clause with no corresponding step.
-   **Drift** — does the plan solve a *different* (perhaps more interesting)
    problem than the one asked?
-   **Acceptance** — if this plan were executed perfectly, would the reporter of
    the bug consider it fixed? What would still be broken or unaddressed?
-   **Unstated assumptions** — does the plan depend on assumptions the
    requirement doesn't support, or reinterpret ambiguous requirements without
    flagging it?
-   **Missing edge cases the requirement implies** (error states, empty inputs,
    permissions) that the plan omits.

Do NOT evaluate elegance or approach quality — only fidelity to the requirement.

Output: a JSON array of findings matching `schema/finding.json`, with `lens:
"requirements_fidelity"` and `location: "plan"`. For each gap, name the specific
requirement clause it fails.
