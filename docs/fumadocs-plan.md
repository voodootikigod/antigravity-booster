# Fumadocs Migration Plan

This document outlines the strategy for migrating the `antigravity-booster` documentation from flat Markdown files to a structured, interactive documentation site powered by [Fumadocs](https://fumadocs.vercel.app/).

## Why Fumadocs?
- **Next.js App Router Support:** Modern, fast, and highly customizable.
- **MDX Support:** Allows embedding interactive React components in our documentation (e.g., interactive CLI explorers, live configuration testers).
- **Built-in Search:** Powerful text search out of the box.
- **Great DX and UX:** Superior navigation, TOC generation, and dark mode support.

## Migration Strategy

### Phase 1: Setup and Foundation
1. **Initialize Next.js App:**
   - Create a `website` directory at the root of the repository.
   - Run `npx create-next-app` inside `website` and follow the Fumadocs setup guide to integrate `fumadocs-ui` and `fumadocs-core`.
2. **Establish Information Architecture (IA):**
   - **Getting Started:** Installation, Quickstart, ADLC Core Concepts.
   - **Core Guides:** Execution Walkthroughs, Configuration.
   - **Reference:** CLI Command Reference, API Reference, Error Codes.
   - **Internal Doctrine:** AGENTS.md, Guidelines, Research.

### Phase 2: Content Porting
1. **Migrate Existing Markdown:**
   - Port `README.md` (Installation and Quickstart) into the *Getting Started* section.
   - Port `docs/usage.md` into the *Reference / CLI Reference* section.
   - Port `docs/guidelines.md` and `AGENTS.md` into the *Internal Doctrine* section.
   - Port `docs/execution-example.md` into the *Core Guides* section.
2. **Refactor Content:**
   - Utilize Fumadocs UI components like Callouts, Tabs (e.g., for showing `npm` vs `npx` install instructions), and Steps.
   - Ensure links between pages are updated to relative routes within the Fumadocs structure.

### Phase 3: CI/CD Integration
1. **Automated Deployments:**
   - Configure a GitHub Actions workflow to build and deploy the `website` directory to Vercel or GitHub Pages on pushes to `main`.
2. **Linting and Validation:**
   - Add a step in the CI pipeline to run `npm run build` inside `website` to catch broken links and MDX syntax errors before merging PRs.

### Phase 4: Deprecation of Legacy Docs
1. **Update Repository Root Docs:**
   - Replace the heavy content in the root `README.md` with a clean, concise summary of the project and a direct link to the new Fumadocs documentation site.
   - Remove the `docs/` directory from the repository root (excluding items that must remain, like `AGENTS.md` if mandated by ADLC).

## Next Steps
- Open a ticket to initialize the Next.js/Fumadocs skeleton in the `website/` directory.
- Define the `meta.json` structure to reflect the proposed IA.
