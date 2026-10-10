# Product

## Register

product

## Users

Three readers share one site, and the design has to serve all of them without compromising any:

- **Engineers adopting agb.** They have Google Antigravity (`agy`) installed and want to run large, parallel agent build-outs without losing control. They arrive mid-task: installing the plugin, decoding a failed gate, looking up an env var or exit code. They scan, jump, copy commands, and leave.
- **Agents reading the docs.** LLM agents consume the same content through `llms.txt`, `llms-full.txt` and per-page markdown. Every page must stay structurally clean and machine-legible; visual flourish never carries meaning that the text does not.
- **ADLC-curious leads.** They evaluate whether the Agentic Development Lifecycle approach is worth adopting. They read the Concepts section start to finish and need the why, not only the how.

## Product Purpose

The docs site for `antigravity-booster` (`agb`), an independent, open-source orchestrator that imposes the ADLC on Google Antigravity: a deterministic scheduler, quota-pool-aware dispatch, frozen rails, sandboxed gates and cross-model prosecution for fleets of coding agents. Success is a reader finding the exact fact they need in seconds, trusting that it is true at v1.0.0 (every claim links its source line), and leaving with a correct mental model of how agb keeps agents disciplined.

## Brand Personality

**Precise, calm, mission-control.** agb is the flight controller that sits on top of Antigravity's launch platform: it does not add lift, it adds discipline. The voice is confident and plain, instrument-panel exact, never hyped. Antigravity's spacious calm is the family resemblance; the precision of a control room is what makes it agb's own. Readers should feel that the system is under control and that the docs are telling them the whole truth.

## Anti-references

- **Stock Fumadocs / Nextra defaults.** The neutral template look: grey sidebar, default accent, nothing that says what this tool is.
- **A Google property clone.** agb is independent. No Google logo, legal bar, product marks, or copy that implies Google authorship. Borrow the visual language, never the identity.
- **Neon-dark "AI tool" aesthetic.** Purple-to-blue gradients, glow, glassmorphism on black, particle backgrounds.

## Design Principles

1. **Practice what you preach.** A tool about discipline gets a disciplined interface: one accent, a strict type scale, consistent spacing, no decoration that does not do a job.
2. **Instrument, not billboard.** Reference and guide pages are working surfaces. Density and scannability beat spectacle; the landing page is the one place allowed to breathe big.
3. **Evidence is a first-class element.** Claims, source permalinks, known-issue callouts and exit-code tables are the product's credibility; give them deliberate, recognizable treatment rather than burying them.
4. **Family resemblance, own identity.** Feel at home next to Antigravity (light, airy, precise, rounded) while being unmistakably agb.
5. **Legible to machines too.** Nothing meaningful lives only in visuals; structure and text carry everything.

## Accessibility & Inclusion

WCAG 2.2 AA in both light and dark themes: text contrast at least 4.5:1 (3:1 for large text and UI boundaries), visible focus indicators on every interactive element, full keyboard navigation, and no information conveyed by color alone. All motion is disabled under `prefers-reduced-motion: reduce`.
