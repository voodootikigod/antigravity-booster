# Fumadocs Migration Plan for Antigravity Booster

This document outlines the plan to migrate the existing markdown documentation into a robust, interactive, and highly polished developer portal using [Fumadocs](https://fumadocs.dev/).

## 🎯 Objectives
1. **Elevate the Developer Experience (DX):** Create a beautiful, easy-to-navigate documentation website.
2. **Focus on Onboarding:** Highlight "How to Install", "How to Use", and "Quickstart" so developers can get up and running instantly.
3. **Organize Deep-Dives:** Structure the ADLC doctrine, architecture tradeoffs, and research calibration into an intuitive sidebar hierarchy.
4. **Adhere to ADLC:** Execute this migration via strict tickets in `.adlc/tickets.json`.

## 📂 Proposed Content Structure

Fumadocs uses file-system-based routing with MDX. We will map the current flat structure to a hierarchical one:

```text
website/content/docs/
├── index.mdx                  # Overview & Features (from README.md)
├── getting-started/
│   ├── install.mdx            # Expanded "How to Install"
│   └── quickstart.mdx         # End-to-end "How to Use" & Walkthrough
├── reference/
│   ├── cli.mdx                # Command Reference (from docs/usage.md)
│   ├── plan-schema.mdx        # plan.json & sweep.json schemas
│   └── env-vars.mdx           # Environment Variables
├── architecture/
│   ├── adlc-doctrine.mdx      # ADLC P0-P7 (from docs/guidelines.md)
│   ├── execution-gates.mdx    # Gates & Cross-Model Prosecution
│   └── design-tradeoffs.mdx   # Design tradeoffs & repo locks
└── research/
    ├── platform-findings.mdx  # agy CLI findings (from docs/research)
    └── calibration.mdx        # Probes & Limits (from docs/calibration)
```

## 🛠️ Step-by-Step Implementation

### Phase 1: Fumadocs Setup & Scaffolding
- Initialize a new Fumadocs Next.js application in a `website/` (or `docs-site/`) subdirectory.
- Configure Tailwind CSS with a sleek, dark-mode-first aesthetic matching the Antigravity brand.
- Setup the basic navigation and layout structure.

### Phase 2: Content Migration & MDX Enhancements
- Port existing markdown content into the `website/content/docs` structure.
- **Enhance "How to Install":** Add Fumadocs `<Tabs>` to show different install methods (npx, global, source) clearly.
- **Enhance "How to Use":** Add interactive code blocks, `<Callout>` components for warnings (like sandbox requirements), and Mermaid.js diagrams for the execution flow.
- Add `<Steps>` component for the Quickstart walkthrough.

### Phase 3: CI/CD & Deployment
- Set up a GitHub Actions workflow to build and deploy the `website/` directory to GitHub Pages or Vercel on push to `main`.

## 🎫 ADLC Tickets

To execute this, the following tickets should be added to `.adlc/tickets.json`:

1. **`DOC-1`: Setup Fumadocs framework**
   - **Body:** Initialize Fumadocs in `website/` using Next.js. Configure `fumadocs-ui`, layout, and basic theme. Set up the `content/docs` structure.
   - **Scope:** `website/**`

2. **`DOC-2`: Migrate Onboarding Docs**
   - **Body:** Create `getting-started/install.mdx` and `getting-started/quickstart.mdx` using MDX components (Tabs, Steps).
   - **Scope:** `website/content/docs/getting-started/**`
   - **Edges:** Depends on `DOC-1`

3. **`DOC-3`: Migrate Reference & Architecture Docs**
   - **Body:** Migrate `docs/usage.md` and `docs/guidelines.md` into MDX pages under `reference/` and `architecture/`. Add Mermaid diagrams for the Execution Gates.
   - **Scope:** `website/content/docs/reference/**`, `website/content/docs/architecture/**`
   - **Edges:** Depends on `DOC-1`

4. **`DOC-4`: Deployment Configuration**
   - **Body:** Add a GitHub Actions workflow `.github/workflows/docs.yml` to build and deploy the Next.js static export.
   - **Scope:** `.github/workflows/docs.yml`, `website/next.config.mjs`
   - **Edges:** Depends on `DOC-1`
