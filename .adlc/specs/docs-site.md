# Architecture & Execution Plan: Fumadocs Documentation Site

Revision 3 (2026-10-09). Revision 3 applies the owner decision of 2026-10-09 to host on **Vercel** instead of GitHub Pages (D1, D8, §3.1, §7.11, §8, AC7–AC9, AC19, AC20, AC26, AC28, AC33, AC34, §12). Revision 2 resolved revision 1's spec-lint (AC20), premortem (rails deadlock, generated-docs deadlock) and parallax (ambiguity about 0.55) findings. Revision 3 review pass (2026-10-09) fixed canonical no-trailing-slash URLs, Vercel Node resolution via `engines` (`22.x`), AC34 evidence, Ignored Build Step, the exact search-index shape, the OG slug handling, `/docs` root coverage and the `changes` job checkout. Appendix A maps each finding to the section that resolves it.

## 1. Executive Summary

This document specifies how the `antigravity-booster` (`agb`) v1.0.0 documentation is rebuilt as a **Fumadocs** site in `website/` using the default Next.js server output, deployed on **Vercel** through the Vercel GitHub integration. The work also corrects every stale claim found in the 2026-10-09 audit of the root docs against the code.

It absorbs and supersedes `docs/fumadocs-plan.md`. That file recommends `create-next-app` and an "Internal Doctrine" section that copies AGENTS.md; both contradict this spec. T-DOCS-SCAFFOLD (the first PR of the docs stack, after the PR that adds this spec) puts a superseded banner on it, and T-DOCS-ROOT-SLIM deletes it.

### Core boundaries
1. **The site is isolated from the shipped plugin.** `website/` has its own `package.json` and `package-lock.json` and is not an npm workspace. The root `files` whitelist, root `npm test`, `dist/`, `vendor/` and the `ci.yml` "Bundle drift gate" never depend on `website/`.
2. **The docs describe v1.0.0 behavior.** Code defects found by the audit are fixed only by `T-CODE-FIXES-AUDIT` (§10.3), never by a docs ticket. Where a defect is user-visible, the page states the current behavior in a callout whose first line is exactly `Known issue (T-CODE-FIXES-AUDIT item <N>)`, with `<N>` the item number in §10.3. T-CODE-FIXES-AUDIT removes or rewrites each callout in the same PR that fixes the item; `check-known-issues` (§7.9) fails once that ticket is archived and a callout remains.
3. **Generators read the code; they never run it.** Every generated reference partial comes from static parsing of source text (§7). No generator `import()`s or `require()`s a `lib/`, `bin/`, `mcp/`, `hooks/`, `sidecars/` or root `scripts/` module.

### Owner decisions (binding)
| # | Decision |
|---|---|
| D1 | Host on **Vercel** with the default Next.js server output (no static export), deployed by the Vercel GitHub integration: production from `main`, a preview deployment per PR. **Supersedes** revision 2's "GitHub Pages with a Next static export" (owner decision 2026-10-09). Static export is dropped because Vercel serves the server output natively, which enables the standard Orama server search route, dynamic OG images and `llms.txt` with no basePath. |
| D2 | `USAGE.md`, `ARCHITECTURE.md`, `docs/guidelines.md`, `docs/usage.md`, `docs/execution-example.md` and `docs/README.md` become **stubs** (format in §5.1) that link to the site. They are not deleted. `README.md` is slimmed to at most 120 lines (§5.2). `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` and `AGENTS.md` stay in the repo root. |
| D3 | The rails-guard directory-store fix is **done** (#87, archived in #88). No docs ticket covers it. The docs describe the fixed behavior: CI rails-guard reads rails from active tickets in the `.adlc/tickets/` store, or from the legacy `.adlc/tickets.json`. |
| D4 | Code defects go to `T-CODE-FIXES-AUDIT`, a separate, independent stream with no edges to or from the docs stack. |
| D5 | AGENTS.md edits need owner-approved wording and get their own PR (T-DOCS-AGENTS-MD). |
| D6 | Any change under `.github/**` needs owner CODEOWNERS review. Creating the Vercel project, connecting the repository, setting Root Directory = `website/` and Node.js version 22.x, and granting the Vercel GitHub app access to this repository are **owner actions** (§8.1). Agents never merge such a PR, never change repository or Vercel settings, and never handle Vercel tokens. |
| D7 | The documented agy floor is `1.2.6`, matching `MIN_AGY_VERSION` (`lib/doctor.mjs:26`). Raising it would be a code ticket. |
| D8 | The site uses the default Vercel production URL assigned when the owner creates the project (`https://<project>.vercel.app`). No custom domain. The owner records the exact URL here and in `website/README.md` (`DOCS_URL: <url>` line) once the project exists; until then this spec refers to it as `DOCS_URL`. `DOCS_URL` = *to be recorded by the owner*. |
| D9 | Design history is **listed in the nav** under Project → Design history, every page carries the banner `Historical, superseded`, and its pages are **excluded from the search index**. |
| D10 | The site deploys to Vercel production on every push to `main` and therefore documents `main`. Every page shows a banner generated from root `package.json` `version`: `These docs track main. Latest release: v<version>.` (§3.1). Versioned docs stay out of scope (N5). |
| D11 | Evidence links in site content point at the tag permalink `https://github.com/voodootikigod/antigravity-booster/blob/v1.0.0/<path>#L<n>`. A link to `blob/main/...#L<n>` fails `check-evidence` (§7.8). Plain file links (no `#L`) may use `blob/main`. |

---

## 2. Goals and Non-Goals

### 2.1 Goals
Each goal names the acceptance criteria (§11) that verify it.
- G1. One canonical docs site covering exactly the pages in §4: CLI, slash commands, agents, skills, MCP tools, hooks, sidecar, environment variables, file layout, release and supply chain. Full-text search covers every page except design history. (AC9, AC13, AC14, AC24)
- G2. Every stale claim C1–C35 in §6 is corrected on its target pages. Each correction is checked either by a forbidden pattern in `check-stale-claims` or by a `claims:` frontmatter entry backed by a v1.0.0 permalink in `check-evidence`. (AC15, AC16, AC17)
- G3. The reference partials listed in §7 are generated from source and committed. The CI `gen-check` job fails when the committed output differs from a fresh run. (AC10, AC11, AC12)
- G4. No new trust surface in CI: `docs.yml` has no deploy job, no `id-token`/`pages` permission and no `secrets.*`, and every action is SHA-pinned. The only new third-party access is the owner-granted Vercel GitHub app, recorded as a trust note (§8.1). (AC26, AC33)
- G5. The plugin is not weakened: the tarball **file list** is unchanged (only the content of always-shipped `README.md` changes, in T-DOCS-ROOT-SLIM, with a CHANGELOG entry), root `npm test` passes offline, and `dist/`/`vendor/` are byte-identical on every docs PR. (AC1, AC2, AC3)

### 2.2 Non-Goals
- N1. Fixing code defects (see T-CODE-FIXES-AUDIT).
- N2. A custom domain, a deploy job or Vercel CLI/token in GitHub Actions, GitHub Pages, and a `vercel.json` (not needed, §8.1).
- N3. Moving `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` or `AGENTS.md` out of the repo root.
- N4. Changing `.adlc/config.json` in any way.
- N5. Versioned docs.
- N6. Any hardcoded count on the site or in root docs: test counts, dependency counts, file counts. Pages say "run `npm test`" or describe the set without a number.

---

## 3. Stack (verified with `npm view` on 2026-10-09)

| Item | Exact version | Placement | Notes |
|---|---|---|---|
| Scaffold | `create-fumadocs-app@16.2.18` | — | Command in §3.2 |
| `fumadocs-core` | `16.17.1` | dependencies | `fumadocs-ui@16.17.1` requires an exact match |
| `fumadocs-ui` | `16.17.1` | dependencies | |
| `fumadocs-mdx` | `15.4.7` | dependencies | |
| `next` | `16.4.0` | dependencies | |
| `react`, `react-dom` | `19.3.0` | dependencies | Peer range `^19.2.0`. Both pinned to `19.3.0` regardless of what the scaffold writes. |
| `mermaid` | `12.1.0` | dependencies | Client `<Mermaid>` component plus `remarkMdxMermaid` in `source.config.ts` |
| `next-themes` | `0.4.6` | dependencies | Mermaid theme switch |
| `next-validate-link` | `1.6.7` | devDependencies | `npm run lint:links` |
| Scaffold-added tooling (typescript, `@types/*`, biome, tailwind, lucide-react, postcss and similar) | the version resolved in `website/package-lock.json` at scaffold time, written exactly | devDependencies unless imported at runtime | No `^`/`~`; AC4 enforces |
| Node | `22.x` | `engines` | Bounded to the 22 major on purpose: Vercel takes the Node version from `engines.node` and overrides the dashboard setting, and an open range such as `>=22.19.0` would make it build on the newest supported major (24.x). Vercel resolves `22.x` to its latest 22 minor, which is above the root floor. `website/.nvmrc` contains `22.19.0` (the root `engines.node` floor; CI and local dev use it) and changes only when root `engines` changes. Root `package.json` `engines.node` stays `>=22.19.0`. |
| Optional peers intentionally **not** installed | `takumi-js`, `vite`, `rolldown`, `satteri` | — | OG images use `ImageResponse` from `next/og` (bundled with `next`, scaffold flag `--og-image next-og`), so `takumi-js` (latest `2.14.0` on 2026-10-09) is not needed. `website/README.md` contains a section "Expected peer warnings" naming all four. |

No generator dependency is added: the generators use only `node:` built-ins and regular expressions, so the CI `gen-check` job runs without `npm ci` (§8). `acorn` is **not** used.

If any version in this table is no longer installable when T-DOCS-SCAFFOLD runs, the implementer stops and asks the owner. They do not substitute a version.

### 3.1 Server-output configuration (Vercel)
- `website/next.config.mjs`: no `output`, no `basePath`, no `trailingSlash`, no `images.unoptimized` (Vercel serves the default server output at the domain root). It contains only the Fumadocs MDX wrapper (`createMDX()`) and `reactStrictMode: true`.
- No environment variable is required at build or run time, locally or on Vercel. Local development uses `npm run dev` (`next dev`); a production-like local run is `npm run build && npm run start`.
- Routes: `/` is `app/(home)/page.tsx`, a minimal landing (pitch, install command, link to `/docs`). Docs live at `/docs/<path>`. `content/docs/index.mdx` is the Introduction page at `/docs`. Canonical internal URLs have **no trailing slash** (Next's default `trailingSlash: false` 308-redirects `/docs/x/` to `/docs/x`); every authored and generated internal link uses the no-slash form, and §7.11(b) treats a redirect as a failure.
- Search: `app/api/search/route.ts` exports `GET` from fumadocs-core's Orama server search (`createSearchAPI('advanced', { indexes })`, from `fumadocs-core/search/server`), where `indexes` is built from `source.getPages()` **filtered to omit every page whose URL contains `/docs/project/design-history/`**. Exact shape: `createSearchAPI('advanced', { indexes: source.getPages().filter(p => !p.url.includes('/docs/project/design-history/')).map(p => ({ id: p.url, url: p.url, title: p.data.title, description: p.data.description, structuredData: p.data.structuredData })) })`. `createFromSource(source)` (the stock Fumadocs template) is **forbidden** because it cannot exclude pages; if the 16.17.1 types reject a field name above, adapt to the type definitions in `node_modules/fumadocs-core` and name the change in the PR description. The client uses the default Fumadocs search dialog, which fetches `/api/search`.
- OG images: `app/og/docs/[...slug]/route.tsx` returns `ImageResponse` from `next/og` with the page title and description; docs page `generateMetadata` points `openGraph.images` at `/og/docs/<slug>/image.png`. Following the Fumadocs `next-og` template, the handler **drops the last slug segment (`image.png`)** before calling `source.getPage(slug.slice(0, -1))` (404 via `notFound()` otherwise), and the route exports `generateStaticParams` returning `source.getPages().map(p => ({ slug: [...p.slugs, 'image.png'] }))`.
- `llms.txt`: `app/llms.txt/route.ts` (index of page titles and URLs) and `app/llms-full.txt/route.ts` (processed Markdown of every page) using Fumadocs' `getLLMText` pattern; both exclude `/docs/project/design-history/` like search.
- Version banner: `app/layout.tsx` (or the docs layout) renders `These docs track main. Latest release: v<version>.`, where `<version>` is read at build time from `../package.json` with `fs.readFileSync` (a JSON read, not a module import).
- Frontmatter schema in `source.config.ts` adds optional `claims: string[]` (ids from §6) and `placeholder: boolean`.
- There is no `postbuild` and no `prebuild`: `npm run build` is `next build` only, and generation is the explicit `npm run gen` step.
- The root `.gitignore` gains `website/.next/`, `website/node_modules/`, `website/.source/`, `website/.vercel/`.

### 3.2 Scaffold command
`npx create-fumadocs-app@16.2.18 website --template +next+fuma-docs-mdx --search orama --og-image next-og --pm npm --linter biome --no-git --install -y`

Every flag above was confirmed against `npx create-fumadocs-app@16.2.18 --help` on 2026-10-09 (`--template` choices include `+next+fuma-docs-mdx`; `--og-image` choices are `next-og`, `takumi`).

If the CLI rejects a flag anyway, choose the documented equivalent from `--help` for: Next.js + Fumadocs MDX template (server output, not `+static`), Orama search, `next-og` OG images, npm, biome, no git init. Name the substitutions in the PR description. The end state is fixed by §3, §3.1 and AC4–AC9 regardless of flags.

### 3.3 `website/package.json` scripts (contract)
| Script | Command |
|---|---|
| `dev` | `next dev` |
| `build` | `next build` |
| `start` | `next start` |
| `gen` | `node scripts/gen-reference.mjs` |
| `check` | `node scripts/check-all.mjs` (runs §7.7–§7.10 checks on `content/` and `generated/`; no build needed) |
| `check:site` | `node scripts/check-site.mjs` (runs §7.11 checks against `next start` on `127.0.0.1`; needs a prior `npm run build`) |
| `lint:links` | next-validate-link over `content/docs` |
| `test` | `node --test scripts/test/` |

---

## 4. Information Architecture

Pages live under `website/content/docs/`. Every folder has a `meta.json` with an explicit `pages` array, and every `.mdx` file in a folder is listed in that folder's `pages` (checked by `check-ia`, §7.10). Generated partials live in `website/generated/`, **outside** `content/docs/`, so they never become routes; pages pull them in with `<include>../../../generated/<name>.mdx</include>` (relative path adjusted per depth).

**Placeholders.** T-DOCS-SCAFFOLD creates every page below as a placeholder: frontmatter `title`, `placeholder: true`, and the single body line `This page is being written.`. Content tickets replace placeholders with real pages and remove `placeholder: true`. This lets any page link to any other page from the first PR on, so link checks pass regardless of merge order. After T-DOCS-ROOT-SLIM no placeholder remains (AC14).

`SRC` names the content source. `GEN` names the generated partial (§7) the page includes. `[T]` names the owning ticket.

```
index.mdx                 Introduction. SRC README "Why" + docs/README.md                         [GETSTARTED]
meta.json  ["index","---Getting Started---","getting-started","---Concepts---","concepts",
            "---Guides---","guides","---Reference---","reference","---Internals---","internals",
            "---Project---","project"]                                                            [SCAFFOLD]

getting-started/  ["installation","bootstrap","quickstart","upgrading-from-npm","verify"]        [GETSTARTED]
  installation.mdx        Prereqs (agy >= 1.2.6, Node >= 22.19.0), agy plugin install, ~/.local/bin/agb shim
  bootstrap.mdx           What bootstrap does (plugin via agy/jetski, skills, shim; no sidecar), --force/-f, --force-reinstall, aliases
  quickstart.mdx          plan -> run -> status, artifacts, exit codes
  upgrading-from-npm.mdx  agb migrate / --rollback / --force-rollback / --break-lock; state machine summary
  verify.mdx              Each agb doctor check id (incl. bwrap_*, ticket-store conflict) with its fix text quoted from lib/doctor.mjs

concepts/  ["overview","agb-vs-boost","plan-boundary","pools-and-tiers","gates-and-sandboxing",
            "prosecution","rail-enforcement","gate-evidence"]                                     [CONCEPTS]
  overview.mdx            Four layers, control flow vs judgment
  agb-vs-boost.mdx        The only copy of the comparison table
  plan-boundary.mdx       Compile gates: spec-lint, coldstart, parallax, premortem (advisory), scope-overlap
  pools-and-tiers.mdx     Pools gemini, claude, claude-gpt, gpt-oss; TIER_CANDIDATES; per-pool caps; prosecutor mapping
  gates-and-sandboxing.mdx  Seatbelt / bwrap / Windows attestation, network denied, fail-closed rules, AGB_SANDBOX_GATES
  prosecution.mdx         Cross-model prosecution, dryPasses, hollow-test
  rail-enforcement.mdx    Rails, CI rails-guard (dir store + legacy), PreToolUse guard, residual risks, AGB_HOOK_DISABLE
  gate-evidence.mdx       gate-manifest record/verify

guides/  ["walkthrough","writing-plans","sweeps","sidecar-dashboard","review","operating-tips","headless-and-mcp"]  [GUIDES]
  walkthrough.mdx         Spec to merged plan, rewritten from docs/execution-example.md
  writing-plans.mdx       Hand-written plan.json, sizing, edges semantics
  sweeps.mdx              Sweep and recursive modes
  sidecar-dashboard.mdx   agb sidecar, token URL, --port, ANTIGRAVITY_SIDECAR_WEB_PORT security note (links reference/security)
  review.mdx              agb review fleet, ref forms, exit semantics
  operating-tips.mdx      Quotas, blocked tickets, pool drain, dirty repos
  headless-and-mcp.mdx    Slash-command model, print-mode residual risk, the MCP server

reference/  ["cli","slash-commands","agents","skills","plan-schema","sweep-schema","environment",
             "plugin-layout","mcp-tools","file-layout","log-formats","exit-and-error-codes",
             "calibration","agy-integration","security"]
  cli/  ["index","run","sweep","plan","validate","preflight","review","status","doctor","bootstrap",
         "migrate","sidecar","probe","pool","brains","import-brain","removed"]   GEN cli-<command>.mdx   [GEN]
  slash-commands.mdx      GEN slash-commands.mdx                                                  [GEN]
  agents.mdx              GEN agents.mdx                                                          [GEN]
  skills.mdx              GEN skills.mdx; release skill links project/releasing                  [GEN]
  environment.mdx         GEN environment.mdx                                                     [GEN]
  plugin-layout.mdx       GEN plugin-layout.mdx                                                   [GEN]
  mcp-tools.mdx           GEN mcp-tools.mdx                                                       [GEN]
  plan-schema.mdx         TypeTable + <include> templates/plan.example.json; drift-checked (§7.7) [REFERENCE]
  sweep-schema.mdx        TypeTable; drift-checked (§7.7)                                         [REFERENCE]
  file-layout.mdx         Target repo .booster/ + .adlc/; user-global ~/.gemini, ~/.adlc          [REFERENCE]
  log-formats.mdx         events.jsonl, transcripts, run.json, report shape                       [REFERENCE]
  exit-and-error-codes.mdx                                                                        [REFERENCE]
  calibration.mdx         Current numbers; links every docs/calibration/probes-*.md; marks probes-2026-06-11 superseded on the site only  [REFERENCE]
  agy-integration.mdx     --project isolation, stream-json + conversation_id, timeouts            [REFERENCE]
  security.mdx            Threat model; the canonical ANTIGRAVITY_SIDECAR_WEB_PORT note; links root SECURITY.md  [REFERENCE]

internals/  ["architecture","plan-compiler","run-lifecycle","integration-journal","plugin-and-migration",
             "policy-guard","build-and-bundle","module-map"]                                      [INTERNALS]
  architecture.mdx        Layers (Mermaid)
  plan-compiler.mdx
  run-lifecycle.mdx       Worktree -> build -> gates -> prosecute -> integration worktree -> CAS update-ref
  integration-journal.mdx
  plugin-and-migration.mdx  Resolution chain, bundled mode, vendor tarball pinning, migration states; links .adlc/specs/native-plugin-installation.md and docs/specs/native-plugin-installation.md
  policy-guard.mdx        hooks/policy/* pipeline: constants, shell-lexer, shell, paths, evaluate, verdict
  build-and-bundle.mdx    esbuild bundles, __AGB_BUNDLED__, dist/vendor drift gate, scripts/check-bundle-externals.mjs
  module-map.mdx          GEN modules.mdx

project/  ["contributing","adlc-in-this-repo","releasing","stability","changelog","design-history"]  [PROJECT]
  contributing.mdx        <include> generated/contributing.mdx (§7.6)
  adlc-in-this-repo.mdx   CI self-protection, frozen rails, archive-on-merge; links AGENTS.md (no copy)
  releasing.mdx           publish.yml (OIDC), release-drift.yml, docs/github-rulesets, skills/release, .claude/release-profile.md
  stability.mdx           Semver since 1.0.0, support policy
  changelog.mdx           <include> generated/changelog.mdx (§7.6)
  design-history/  ["index","roadmap-agy-1-1-11","roadmap-agy-1-2-8","antigravity-gui","linux-sandbox","agy-cli","native-plugin-installation"]
    Every page starts with the callout "Historical, superseded" and the correction rows from §6 that apply.
    index.mdx                       What design history is
    roadmap-agy-1-1-11.mdx          copy of docs/archive/research/roadmap-agy-1.1.11.md
    roadmap-agy-1-2-8.mdx           copy of docs/archive/research/roadmap-agy-1.2.8-adlc-1.11.1.md
    antigravity-gui.mdx             copy of docs/archive/research/antigravity-gui.md
    linux-sandbox.mdx               copy of docs/archive/research/linux-sandbox.md (+ C35 banner)
    agy-cli.mdx                     copy of docs/archive/research/agy-cli.md (+ C34 banner)
    native-plugin-installation.mdx  a summary of at most 30 lines plus a link to .adlc/specs/native-plugin-installation.md (not a copy)
```

---

## 5. Content Map

| Existing doc | Site destination | Repo fate | Ticket |
|---|---|---|---|
| `README.md` | "Why" → index. Install/quickstart → getting-started. /boost table → concepts/agb-vs-boost. Commands/env → reference. Modes → guides/sweeps. Stability → project/stability | **Slimmed** (§5.2) | ROOT-SLIM |
| `USAGE.md` | getting-started, reference/cli, plan-schema, environment | **Stub** (§5.1) | ROOT-SLIM |
| `docs/usage.md` | concepts/plan-boundary, log-formats, sweep-schema, operating-tips | **Stub** | ROOT-SLIM |
| `ARCHITECTURE.md` | internals/*, concepts/gates-and-sandboxing | **Stub** | ROOT-SLIM |
| `docs/guidelines.md` | concepts/*, project/adlc-in-this-repo | **Stub** | ROOT-SLIM |
| `docs/execution-example.md` | guides/walkthrough (rewritten) | **Stub** | ROOT-SLIM |
| `docs/README.md` | index | **Stub** | ROOT-SLIM |
| `docs/fumadocs-plan.md` | Absorbed by this spec | Superseded banner (SCAFFOLD); deleted (ROOT-SLIM) | SCAFFOLD, ROOT-SLIM |
| `docs/research/*.md` (5 files) | project/design-history | `git mv` to `docs/archive/research/` (not shipped: `files` lists only `docs/calibration/`) | PROJECT |
| `docs/specs/native-plugin-installation.md` | Linked | Stays | — |
| `docs/calibration/*` | reference/calibration | **Unchanged** (ships in `files`, required by `test/packaging.test.mjs`). The superseded status of `probes-2026-06-11.md` is stated on the site only. | — |
| `CONTRIBUTING.md`, `SECURITY.md` | Included (contributing) or linked (security) | Stay; stale claims fixed in place | ROOT-SLIM |
| `CHANGELOG.md` | Included (changelog) | Stays; ROOT-SLIM adds one `Unreleased` entry for the README change | ROOT-SLIM |
| `AGENTS.md` | Linked | Edited only in T-DOCS-AGENTS-MD (D5) | AGENTS-MD |
| `docs/github-rulesets/` | Described in project/releasing | Stays | — |

### 5.1 Stub format
A stub contains, in order: the original H1; one sentence saying the content moved; a link to the matching site page under `<DOCS_URL>/docs/` (D8); then **every H2 of the `origin/main` version, with identical text** (so `#anchor` links keep resolving), each followed by exactly one line linking to the site page that now covers it. No H3s, no code blocks. Line budget: at most `6 + 3 × (number of H2s)` lines. AC19 checks all of this.

### 5.2 README slim
`README.md` keeps: H1 and pitch, a three-line install, the site link, `## Stability`, `## Contributing`, `## Security`, and a heading whose text is exactly `agb migrate` (preserves `#agb-migrate`) followed by one line linking `getting-started/upgrading-from-npm/`. At most 120 lines. No test or dependency counts.

---

## 6. Stale-Claim Corrections

C1–C8 were confirmed by reading the cited source at `4864376`. C9–C35 come from the audit inventory; the ticket that writes the target page re-reads the cited code at tag `v1.0.0`, and the page records the claim in its `claims:` frontmatter and links the exact line with a v1.0.0 permalink (D11). If the code disagrees with this table, the code wins; the PR description says which row was wrong.

"Pattern" is the forbidden regex `check-stale-claims` (§7.8) applies to site content (excluding `design-history/`) and, with `--with-root`, to the root docs. `—` means the row is verified by `claims:` + permalink only.

| # | Stale claim | Correct (v1.0.0) | Evidence | Target pages | Pattern |
|---|---|---|---|---|---|
| C1 | `agy >= 1.2.8` | `>= 1.2.6` | `lib/doctor.mjs:26` | installation, verify, README, stubs | `agy[^\n]{0,20}1\.2\.8` |
| C2 | `AGB_STREAM_TIMEOUT`/`_LINE_CAP`/`_TOTAL_CAP` env vars | Do not exist. Caps are hardcoded: 1 MB per line, 50 MB total, 5 MB consecutive garbage | `lib/agy.mjs:18-20` | environment, agy-integration | `AGB_STREAM_(TIMEOUT\|LINE_CAP\|TOTAL_CAP)` |
| C3 | `ANTIGRAVITY_SIDECAR_WEB_PORT` is not real | Real. Selects jetski mode (port default 3333) and **skips the sidecar token check** | `sidecars/jetski-launcher.mjs:8-9`, `sidecars/server.mjs:32,43` | environment, sidecar-dashboard, security | — |
| C4 | `pool_hint` takes named Gemini/Claude pools | `gemini \| claude \| claude-gpt \| gpt-oss \| auto` | `lib/plan.mjs:317-318` | plan-schema, pools-and-tiers | — |
| C5 | Worktree `.worktrees/agb-<runId>-<ticketId>` | `.worktrees/agb-<lowercased id>` on branch `agb/<lowercased id>`; integration worktree `agb-integration-<token8>` | `lib/worktrees.mjs:277-281` | cli/run, run-lifecycle, walkthrough | `agb-<runId>` |
| C6 | MCP server version is the package version | `serverInfo.version` reports `0.7.0` — Known issue item 3 | `mcp/server.mjs:155` | mcp-tools | — |
| C7 | Calibration file naming | Committed files are `probes-*.md`; the writer emits `probe-<day>.md`; `lib/pools.mjs:69` cites a nonexistent file — Known issue item 5 | `bin/agb.mjs:350`, `lib/pools.mjs:69` | calibration | — |
| C8 | `AGB_REQUIRE_DRIVER_SIGNATURE` undocumented | `=1` requires a signed driver | `lib/doctor.mjs:982` | environment | — |
| C9 | `agb run --concurrency`, `agb run --dry-run` | Do not exist. Concurrency comes from plan `caps` / `concurrencyCap` | `bin/agb.mjs` COMMANDS | cli/run | `agb run[^\n]*--(concurrency\|dry-run)` |
| C10 | Exit codes | `run`: 1 invalid plan, 2 failures. `validate`: 2 invalid plan | `bin/agb.mjs` | cli/run, cli/validate, exit-and-error-codes | — |
| C11 | Repo arg required for review/status/sidecar | Optional, defaults to `.`; `status --interval <ms>` default 1000; `--ui` removed | `bin/agb.mjs` | cli/review, cli/status, cli/sidecar | `status[^\n]*--ui` |
| C12 | probe usage | `[widths] [model]` optional (defaults `2,4,8` and `Gemini 3.5 Flash (Low)`, shown verbatim with the note "legacy alias"). Output to `AGB_CALIBRATION_DIR` or the plugin's `docs/calibration/` — Known issue item 6 | `bin/agb.mjs:340-355` | cli/probe | — |
| C13 | plan flags | Also `--force`, `--no-coldstart`, `--no-parallax`, `--no-premortem`; premortem advisory; scope-overlap gate | `bin/agb.mjs`, `lib/plan.mjs` | cli/plan, plan-boundary | — |
| C14 | preflight checks model liveness | Refreshes quota telemetry and runs per-ticket coldstart (`--no-coldstart` skips both); no liveness check | `lib/preflight.mjs` | cli/preflight | `model liveness` |
| C15 | Missing commands | `migrate` (+flags), `pool drain`, `import-brain` (deprecated), `--version`, `--project`, `help <cmd>`, `tui` (removed) | `bin/agb.mjs` | cli/* | — |
| C16 | Sidecar token in `.booster/token` | Random 16-byte hex in `http://127.0.0.1:<port>/?token=…`; manifest in `AGB_PLUGIN_DIR` or `~/.gemini/agb-sidecar-plugin-<pid>-<port>`; exit 130/143 on signal | `lib/sidecar*.mjs`, `sidecars/server.mjs` | sidecar-dashboard | `\.booster/token` |
| C17 | `AGB_PLUGIN_DIR` is the adlc plugin path | It is the sidecar manifest directory | grep | environment | — |
| C18 | `AGB_ADLC_BIN` / `ADLC_CLI_PATH` always honoured | Only with `AGB_ALLOW_CUSTOM_ADLC_CLI=1`; ignored in bundled builds | `lib/adlc-bridge.mjs` | environment | — |
| C19 | "~5m hard platform cap" | `AGB_BUILD_TIMEOUT` default 5m, 0 = unlimited for stream-json; 30m ceiling `AGB_BUILD_MAX_TIMEOUT`; 5m no-progress watchdog `AGB_EVENT_PROGRESS_TIMEOUT` | `lib/agy.mjs` | environment, agy-integration | `hard platform cap` |
| C20 | Prosecutor "Claude, and vice versa" | Gemini builders → `gpt-oss-120b-medium`; Claude and gpt-oss builders → `gemini-3.1-pro-high` | `lib/pools.mjs` | pools-and-tiers, prosecution | `and vice versa` |
| C21 | Plan rules | Ids unique case-insensitively; `adlcBin` prohibited; strict-mode gate commands must match the npm regex | `lib/plan.mjs` | plan-schema | — |
| C22 | "macOS-only Seatbelt; Linux fails closed; network allowed; AppContainer" | Seatbelt on macOS, bwrap on Linux; fail closed only when no sandbox is usable; Windows needs HMAC-attested `sandboxBypassAttestation` or `AGB_SANDBOX_GATES=0`; network **denied**; writes limited to worktree + temp; `.git`, `node_modules` read-only; no AppContainer | `lib/gates.mjs` (read only) | gates-and-sandboxing, security, SECURITY.md, CONTRIBUTING.md | `AppContainer` |
| C23 | "Subprocesses inherit env" | Builder agy spawns scrubbed of `FORBIDDEN_SECRETS` and sensitive-name keys (`ENV_ALLOWLIST`, `lib/agy.mjs`); gate commands get the full env | `lib/agy.mjs` | security | — |
| C24 | Automatic `git reset --hard` / `git clean -fd` rollback | Post-merge gates run in an integration worktree; base ref advances only via CAS `update-ref`. (`AGB_ALLOW_DIRTY` warning text is Known issue item 7) | `lib/scheduler.mjs`, `lib/worktrees.mjs` | run-lifecycle, operating-tips | `git (reset --hard\|clean -fd)` |
| C25 | `.booster/lock.json`, `.booster/status.json`, `.adlc/integration_journal.jsonl`, `TRANSACTION_BEGIN` | `.booster/run.lock.d/meta.json`, `.booster/run.json`, `.adlc/integration_journal.json` with phases `PREPARED` … `GATES_PASSED`; plus `.adlc/leases/`, `graph-coupling.json`, ticket store (`tickets/` or legacy `tickets.json`; doctor fails if both) | `lib/*.mjs` | file-layout, integration-journal | `\.booster/(lock\|status)\.json\|integration_journal\.jsonl\|TRANSACTION_BEGIN` |
| C26 | Module map (`PoolManager`, `cleanWorktrees`, `prosecuteDiff`, `startSidecarServer`, …) | Generated (§7.5) | static parse | module-map | `PoolManager\|prosecuteDiff\|startSidecarServer` |
| C27 | Walkthrough ids, models, report keys | `agb/t1`, `.worktrees/agb-t1`, real tier candidates, report keys `runId`, `merged`, `failed`, `requests`, `enforcementAvailable`, `enforcementReason`, `compromised`; sequential rebase-first merges; `agb plan spec.md <repo>` primary | `lib/scheduler.mjs` | walkthrough | — |
| C28 | CONTRIBUTING "ships two first-party deps"; rails text cites `.adlc/tickets.json` as the store | No runtime `dependencies`; every package is a devDependency. Store is `.adlc/tickets/`; CI rails-guard reads it (#87) | `package.json`, `.github/workflows/adlc-rails-guard.yml` | CONTRIBUTING.md | `two first-party` |
| C29 | SECURITY "pre-1.0" | 1.0.0, semver | `package.json` | SECURITY.md, stability | `pre-1\.0` |
| C30 | Fixed test counts | No count; "run `npm test`". AGENTS.md only in T-DOCS-AGENTS-MD | — | README, site | `[0-9]{3,} (tests\|passing)` |
| C31 | Global `npm i -g @adlc/cli` | Contributors run `npm ci`; doctor fix text `npm install @adlc/cli` / `npx agb bootstrap` | `lib/doctor.mjs` | contributing, verify | `npm (i\|install) -g @adlc/cli` |
| C32 | Bootstrap "registers sidecar definitions" | Bootstrap does not install the sidecar (opt-in via `agb sidecar`); writes `~/.local/bin/agb`; aliases `setup`, `install`, `skills install\|setup\|bootstrap` | `bin/agb.mjs`, `lib/bootstrap*.mjs` | bootstrap | `registers sidecar` |
| C33 | MCP `agb_run.concurrency` works | Ignored — Known issue item 2 | `mcp/server.mjs` | mcp-tools | — |
| C34 | agy-cli research "no conversation_id" | Available from json/stream-json | `lib/agy.mjs` | agy-integration, design-history/agy-cli banner | — |
| C35 | linux-sandbox research "proposal" | Implemented (`linuxBwrapArgs`, doctor `bwrap_*`) | `lib/gates.mjs`, `lib/doctor.mjs` | design-history/linux-sandbox banner | — |

Patterns are matched case-sensitively on each line. `check-stale-claims` keeps them in `website/scripts/stale-claims.json` as `{ id, pattern }` objects copied from this table.

---

## 7. Generators and Checks (`website/scripts/`)

All scripts use only `node:` built-ins, read files with `fs.readFileSync`, and never `import()`/`require()` repo code (`lib/gates.mjs` probes the sandbox; `bin/agb.mjs` has a main guard). Exporting `COMMANDS` from `bin/agb.mjs` is out of scope (it would change `dist/`). Every failure prints `<file>:<line>: <reason>` and exits 1. Output is sorted, contains no timestamps, and is byte-identical across runs.

`gen-reference.mjs` writes every partial into `website/generated/` (committed). Flags: `--only <name>` runs one generator (`cli`, `env`, `layout`, `docs-md`, `modules`, `root-docs`); `--env-only` is an alias for `--only env`; `--extra-token <NAME>` (repeatable, env generator only) adds `<NAME>` to the set of tokens found in code, for negative testing. `--check` writes nothing and exits 1 if any output would differ from the committed file.

| # | Generator | Input | Output in `website/generated/` |
|---|---|---|---|
| 7.1 | cli | `bin/agb.mjs`: the `COMMANDS` object literal and `printUsage` text | `cli-<command>.mdx` per command (args, flags, aliases, description), `cli-index.mdx`, `cli-removed.mdx` |
| 7.2 | env | Every `(AGB\|ADLC\|ANTIGRAVITY)_[A-Z0-9_]+` token in files under `lib bin mcp hooks sidecars` and root `scripts/` (not `website/`), diffed against `website/env-docs.json` | `environment.mdx` |
| 7.3 | layout | `plugin.json`, `hooks.json`, `mcp_config.json`, root `package.json` `files`, directory listings of `templates/`, `sidecars/`, `dist/`, `vendor/` | `plugin-layout.mdx` |
| 7.4 | docs-md | Frontmatter of `commands/*.md`, `agents/*.md`, `skills/*/SKILL.md`, and each skill's `scripts/` listing | `slash-commands.mdx`, `agents.mdx`, `skills.mdx` |
| 7.5 | modules | `export` declarations in `lib/*.mjs`, `hooks/**/*.mjs`, `sidecars/*.mjs`, `mcp/*.mjs`, `bin/*.mjs` (named, `export {}` lists, re-exports); plus the MCP tool array in `mcp/server.mjs` (name, description, inputSchema) | `modules.mdx`, `mcp-tools.mdx` |
| 7.6 | root-docs | `CONTRIBUTING.md`, `CHANGELOG.md` | `contributing.mdx`, `changelog.mdx`, with every repo-relative link rewritten to `https://github.com/voodootikigod/antigravity-booster/blob/main/<path>` (file links only) |

### 7.2 detail: `website/env-docs.json`
Shape: `{ "vars": [{ name, group, description, default, bundledIgnored, security }], "ignore": [{ name, reason }] }`.
- The run fails if a code token is in neither `vars` nor `ignore`, or if a `vars`/`ignore` name is not found in code (after adding `--extra-token` values).
- `ignore` holds tokens that are not environment variables, each with a reason. At `4864376` these include at least `AGB_BUNDLED__` (from `__AGB_BUNDLED__`), `ADLC_ANTIGRAVITY_INTEGRITY`, `ADLC_ANTIGRAVITY_TARBALL`, `ADLC_ANTIGRAVITY_VERSION`, `ADLC_ANTIGRAVITY_TREE_DIGESTS`, `ADLC_DIGESTS`, `ADLC_DEPENDENCY_DIGESTS`, `ADLC_CLI_VERSION`, `ADLC_DIR`, and bare prefixes such as `AGB_ALLOW_` and `AGB_DEV_`. The implementer confirms each by reading its use site.
- Group `internal/test-only` (the `AGB_MOCK_*` variables and any other variable only read under test) is kept in `vars` but not rendered.
- Required `vars` entries (each must exist and be rendered): `ANTIGRAVITY_SIDECAR_WEB_PORT` (with `security` text containing `disables token auth`), `ANTIGRAVITY_CONVERSATION_ID`, `ADLC_ADMIN_KEY`, `ADLC_MANIFEST_KEY`, `ADLC_P4_ENFORCEMENT`, `ADLC_PROVIDER`, `ADLC_TICKET`, `ADLC_TICKETS`, `ADLC_TICKET_STORE`, `ADLC_ANTIGRAVITY_PLUGIN_NAME`, `ADLC_ANTIGRAVITY_PLUGIN_PATH`, `AGB_AGY_BIN`, `AGB_CALIBRATION_DIR`, `AGB_ALLOW_DIRTY`, `AGB_BUILD_TIMEOUT`, `AGB_REQUIRE_DRIVER_SIGNATURE`, `AGB_SANDBOX_PROBE_CMD`, `AGB_SANDBOX_PROBE_HELPER`, `AGB_DEV_ALLOW_UNVERIFIED_PLUGIN`, `AGB_HOOK_DISABLE`, `AGB_WORKER_MODE`, `AGB_WORKER_TICKET`, `AGB_STRICT_GATES`, `AGB_SIDECAR_PORT`, `AGB_BUILD_MAX_TIMEOUT`, `AGB_EVENT_PROGRESS_TIMEOUT`, `AGB_KILL_GRACE_MS`, `AGB_QUOTA_TIMEOUT_MS`, `AGB_POOLS_DIR`, `AGB_POOLS_V2`, `AGB_POOLS_LOCK`, `AGB_QUOTA_STATE`, `AGB_HOME_DIR`, `AGB_EXEC_CACHE_DIR`, `AGB_EXEC_LOCKS_DIR`, `AGB_ALLOW_SYSTEM_ADLC`, `AGB_ALLOW_CUSTOM_ADLC_CLI`, `AGB_BRAIN_DIR`, `AGB_ARTIFACT_DIR`, `AGB_SESSION_ID`, `AGB_TARGET_REPO`, `AGB_PROVIDER` (only `jetski` is meaningful), `AGB_SANDBOX_GATES`, `AGB_PLUGIN_DIR`, `AGB_PLUGIN_ROOT`, `AGB_ADLC_BIN`, `ADLC_CLI_PATH`. The generator's test asserts this list (§7.12).
- `bundledIgnored: true` is set on exactly the variables whose read is guarded by `IS_BUNDLED`/`__AGB_BUNDLED__` in source. The implementer finds them with `grep -n "IS_BUNDLED\|__AGB_BUNDLED__" lib/*.mjs bin/*.mjs` and cites each guard with a v1.0.0 permalink in the `description`. At `4864376` this set includes at least `ADLC_ANTIGRAVITY_PLUGIN_PATH` and `AGB_DEV_ALLOW_UNVERIFIED_PLUGIN`; AGENTS.md also names `AGB_PLUGIN_DIR`, `ADLC_CLI_PATH`, `AGB_ADLC_BIN`, `AGB_ALLOW_*`, `AGB_DEV_*` — mark those `true` only where the code guard exists, and list any AGENTS.md/code disagreement as a finding in the PR description (do not edit AGENTS.md).
- Known blind spot: names assembled at runtime (`'AGB_' + k`, template literals) are invisible to the scan. `env-docs.json` documents any such variable by hand in `vars`; the generator then reports it as "not found in code" unless its name also appears literally, in which case the implementer adds a literal-name comment at the use site **only in T-CODE-FIXES-AUDIT** (docs tickets do not edit code) or drops the entry and notes it.

### 7.7–7.11 checks
| # | Script | What it checks |
|---|---|---|
| 7.7 | `check-schema-drift.mjs` | Every field name in the TypeTables of `reference/plan-schema.mdx` and `reference/sweep-schema.mdx` appears as a string in `lib/plan.mjs` / `lib/sweep.mjs`. Skips placeholder pages. |
| 7.8 | `check-stale-claims.mjs` | Applies `stale-claims.json` patterns to `website/content/**` except `project/design-history/**`; `--with-root` adds `README.md USAGE.md ARCHITECTURE.md CONTRIBUTING.md SECURITY.md docs/README.md docs/usage.md docs/guidelines.md docs/execution-example.md`. `--final` also fails unless every id C1–C35 appears in at least one non-placeholder page's `claims:`. |
| 7.8 | `check-evidence.mjs` | For every non-placeholder page with `claims:`, the page contains at least one `blob/v1.0.0/…#L<n>` link per claim id (marked with the id in the link text, e.g. `[C4](…)`). No file under `website/content` or `website/generated` contains `/blob/main/[^)\s]*#L`. |
| 7.9 | `check-known-issues.mjs` | If `.adlc/ticket-archive/` contains a file whose name starts with `t-code-fixes-audit--`, no file under `website/content` may contain `Known issue (T-CODE-FIXES-AUDIT`. Every callout's item number is 1–9. |
| 7.10 | `check-ia.mjs` | Every folder under `content/docs` has `meta.json` with a `pages` array; every `.mdx` is listed; every listed entry exists; the tree equals §4 (the expected tree is kept in `scripts/ia.json`). `--no-placeholders` fails on any `placeholder: true`. |
| 7.11 | `check-site.mjs` | Requires a prior `next build`. Spawns `node_modules/.bin/next start -H 127.0.0.1 -p <port>` (port from `--port`, default `4310`), polls `/` until HTTP 200 (timeout 60 s), runs the checks, then kills the server (also on failure). It fetches **only** `http://127.0.0.1:<port>/…` URLs, so it runs offline; absolute links to other origins are recorded but never fetched. Checks: (a) every page in `ia.json` returns 200 at `/docs/<path>` (the root `index` entry maps to `/docs`), with redirects not followed; (b) every `href`/`src` starting with `/` in every fetched HTML page returns 200 **without following redirects** (a 3xx, including the trailing-slash 308, is a failure, so links must be canonical), except paths under `/api/`; (c) `GET /api/search?query=rails-guard` returns a JSON array with at least one result and no result URL containing `/docs/project/design-history/`, and a query for the design-history index title returns no design-history URL; (d) `/llms.txt` returns 200, contains `/docs/getting-started/installation`, and contains no `/docs/project/design-history/`; (e) `/` contains `Latest release: v` followed by root `package.json` `version`; (f) every design-history page contains `Historical, superseded`; (g) `/og/docs/getting-started/installation/image.png` returns 200 with `content-type: image/png`. |
| 7.12 | `scripts/test/*.test.mjs` | Unit tests run by `npm test` in `website/`: generator determinism; env drift positive and negative (fixture repo with an undocumented token, a stale `vars` entry, and an `ignore` entry); required-entry list from §7.2; `--extra-token`; `--check`; a negative fixture for the `COMMANDS` and MCP-array parsers (spread, computed key) that must fail with `<file>:<line>`; each check script against a passing and a failing fixture under `scripts/test/fixtures/`. |

`check-all.mjs` runs 7.7, 7.8 (without `--with-root`/`--final`), 7.9 and 7.10 (with placeholders allowed), and `gen-reference.mjs --check`.

**Generator contract.** The shape of the `COMMANDS` literal in `bin/agb.mjs` and the tool array in `mcp/server.mjs` is parsed by 7.1/7.5. A code PR that changes those shapes, or adds a flag, env var, export or tool, must run `cd website && npm run gen` and commit `website/generated/` in the same PR. T-DOCS-ROOT-SLIM adds this rule to CONTRIBUTING.md.

---

## 8. CI and Deploy Design

A new workflow `.github/workflows/docs.yml` (owner CODEOWNERS review, D6) with verification jobs only: **it never deploys** (Vercel deploys, §8.1). Every `uses:` is pinned to a 40-character commit SHA with a `# vX.Y.Z` comment. Workflow-level `permissions: {}`; each of the three jobs (`changes`, `gen-check`, `build`) grants only `contents: read`. No `secrets.*`, `id-token`, `pages` or `deployments` permission.

**Job `gen-check`** (`permissions: contents: read`). Triggers: `pull_request` and `push` to `main` on paths `lib/**`, `bin/**`, `mcp/**`, `hooks/**`, `sidecars/**`, `scripts/**`, `commands/**`, `agents/**`, `skills/**`, `templates/**`, `dist/**`, `vendor/**`, `plugin.json`, `hooks.json`, `mcp_config.json`, `package.json`, `CONTRIBUTING.md`, `CHANGELOG.md`, `website/**`, `.github/workflows/docs.yml`. Steps: checkout; `actions/setup-node` with `node-version-file: website/.nvmrc` (no npm install); `node website/scripts/gen-reference.mjs --check`; `node website/scripts/check-all.mjs`; `node --test website/scripts/test/`. It needs no `npm ci`, so code PRs pay seconds, not a Next build.

**Job `build`** (`permissions: contents: read`). Runs only when files under `website/**`, `docs/**`, root `*.md`, or `.github/workflows/docs.yml` changed, or on `push` to `main`. No third-party path-filter action is used. A first job `changes` (`permissions: contents: read`) checks out with `fetch-depth: 0` (so `base.sha`/`before` are resolvable; the default shallow clone cannot diff), then runs `git diff --name-only ${{ github.event.pull_request.base.sha || github.event.before }} ${{ github.sha }}` and sets output `docs=true` when any changed path matches the patterns above (always `true` on push to `main`, and also `true` whenever the diff command fails or `github.event.before` is all zeros: the job fails open toward running the build); `build` has `needs: changes` and `if: needs.changes.outputs.docs == 'true'`. Build steps: checkout (`fetch-depth: 0`); `actions/setup-node` with `node-version-file: website/.nvmrc`, `cache: npm`, `cache-dependency-path: website/package-lock.json`; `working-directory: website`: `npm ci` → `npm run build` → `npm run lint:links` → `npm run check:site` → `node scripts/check-ia.mjs`. Nothing is uploaded.

**No deploy job.** Production and preview deployments come from the Vercel GitHub integration (§8.1). `docs.yml` contains no `actions/configure-pages`, `actions/upload-pages-artifact`, `actions/deploy-pages`, `environment:` or deploy `concurrency` group.

### 8.1 Vercel deployment (owner-operated)
- **Owner actions** (T-DOCS-CI's PR description lists them; agents do none of them): (1) create the Vercel project and connect `voodootikigod/antigravity-booster` through the Vercel GitHub integration; (2) grant the Vercel GitHub app access to **only this repository**; (3) set Root Directory = `website/`, Framework Preset = Next.js (auto-detected), Node.js version = 22.x (Vercel actually resolves the version from `website/package.json` `engines.node` = `22.x`, which overrides this setting; the two agree); default install (`npm ci`, lockfile present) and build (`npm run build`) commands; production branch `main`; (4) set **Ignored Build Step** to `git diff --quiet HEAD^ HEAD -- .` (runs inside Root Directory `website/`, so builds are skipped for commits that do not touch `website/`; exit 0 = skip), so code-only PRs and pushes spend no build minutes; (5) record the production URL as `DOCS_URL` in D8 and in `website/README.md` (AC28).
- **Previews.** Vercel builds a preview deployment for every PR that changes `website/` and reports it as a commit status/check and PR comment (AC33). Preview deployments of unreleased docs are publicly reachable; this is acceptable because the repository is public (`gh repo view --json visibility` → `PUBLIC`, verified 2026-10-09), so previews expose nothing that is not already public.
- **`vercel.json`: none.** Root Directory and Node version are project settings, the Next.js framework preset is auto-detected, and no rewrites, headers, crons or functions config are needed. A `vercel.json` would add a second, drift-prone source of truth. A future need (for example security headers) gets its own PR.
- **Trust note.** The Vercel GitHub app can read repository contents and write commit statuses, deployments and PR comments on this repository. It holds no GitHub secrets, and no Vercel token is stored in GitHub. The site needs no runtime environment variables or secrets on Vercel. Revoking the app (GitHub Settings → Applications) stops deploys without affecting CI or the plugin.

**Required checks.** `docs.yml` is **not** added as a required status check by this spec. The owner may later require `gen-check`; T-DOCS-CI's PR description asks the owner to decide. **Decision: the Vercel deployment check is never a required status check** (Ignored Build Step skips it on code-only PRs, so requiring it could block or flake unrelated PRs; CI `build` + `check:site` is the merge evidence for site correctness).

**Dependency updates.** T-DOCS-CI adds `.github/dependabot.yml` (it does not exist at `4864376`) with one `npm` entry for directory `/website`, weekly, all updates grouped into a single PR, and one `github-actions` entry for `/`, weekly, grouped. Owner review (D6).

**Unchanged workflows.** `ci.yml`, `adlc-rails-guard.yml`, `publish.yml`, `release-drift.yml` are byte-identical to `origin/main` after every docs PR (AC27).

**Owner checklist (in T-DOCS-CI's PR description):** (1) the §8.1 owner actions (Vercel project, repo-scoped app grant, Root Directory `website/`, Node 22.x, Ignored Build Step, Vercel check never required); (2) decide whether `gen-check` becomes required; (3) confirm a Vercel preview check appears on a `website/` PR (AC33) and settings match (AC34); (4) after `main` deploys, record `DOCS_URL` (D8, `website/README.md`) and confirm AC28.

**Packaging guard.** T-DOCS-SCAFFOLD extends `test/packaging.test.mjs`: the existing `npm pack --dry-run --json --ignore-scripts` result must contain no path starting with `website/`, and no path under `docs/` outside `docs/calibration/`.

---

## 9. Rails

The in-session rails hook and CI rails-guard take the **union of rails over every active ticket**. Rails are therefore limited to paths that **no** ticket in either stream ever edits, so co-active tickets can never block each other:

**Every ticket in both streams rails exactly:** `lib/lock.mjs`, `lib/gates.mjs`, `.adlc/config.json`, `CODEOWNERS`.

No ticket lists any of these in its scope (AC21 checks rails ∩ scope = ∅ across the whole set). The things revision 1 tried to protect with rails are protected instead by per-PR diff checks that do not leak across tickets:
- Docs tickets do not touch code or bundles: AC3 (`git diff --quiet origin/main -- lib bin mcp hooks sidecars scripts dist vendor`).
- Docs tickets other than T-DOCS-CI do not touch `.github/`: AC27.
- Only T-DOCS-AGENTS-MD touches `AGENTS.md`: AC23.
- `.adlc/config.json` is untouched everywhere: AC29.

T-CODE-FIXES-AUDIT has `dist/**`, `website/generated/**` and `website/content/**` in scope, and lists `lib/` files individually (every `lib/*` except `lock.mjs` and `gates.mjs`) so its scope never contains its own rails, (to rebuild bundles, regenerate partials and remove Known-issue callouts), so it never collides with docs rails. Concurrent textual edits (for example both streams adding a CHANGELOG bullet) are merge conflicts resolved by rebasing the later PR; they are not rail violations.

**Ticket creation.** Tickets are created with `adlc ticket create --input <file> --write` only after the owner approves this spec (`adlc-approve-spec`). Because rails never intersect any scope, all tickets may be created up front. CI rails-guard refuses to archive a ticket that still has inbound edges, so tickets are archived in edge order.

**Archive on merge (mandatory):** after each ticket's PR merges, a follow-up chore PR (as in #86, #88) runs `adlc ticket complete <id> --write --authorize` then `adlc ticket archive <id> --write --authorize`. AC31 verifies.

---

## 10. Ticket Decomposition

Edges use "precedes" semantics: `{to: X}` means this ticket must merge before X starts. Before `--write`, run `adlc spec-lint`, `premortem`, `coldstart --prompt-only` on the set and `adlc merge-forecast` before fanning out.

### 10.1 Docs stack
| # | id | scope | precedes |
|---|---|---|---|
| 1 | T-DOCS-SCAFFOLD | `website/**` except `website/scripts/gen-reference.mjs`, `website/env-docs.json`, `website/generated/**`; root `.gitignore`; `test/packaging.test.mjs`; `docs/fumadocs-plan.md` (banner only) | GEN, GETSTARTED, CONCEPTS, GUIDES, PROJECT |
| 2 | T-DOCS-GEN | `website/scripts/**`, `website/env-docs.json`, `website/generated/**`, `website/content/docs/reference/{cli/**,slash-commands.mdx,agents.mdx,skills.mdx,environment.mdx,plugin-layout.mdx,mcp-tools.mdx}`, `website/content/docs/internals/module-map.mdx`, `website/package.json` (scripts only) | REFERENCE, INTERNALS, CI |
| 3 | T-DOCS-REFERENCE | the other `website/content/docs/reference/*.mdx` pages in §4 | ROOT-SLIM |
| 4 | T-DOCS-GETSTARTED | `website/content/docs/index.mdx`, `website/content/docs/getting-started/**` | ROOT-SLIM |
| 5 | T-DOCS-CONCEPTS | `website/content/docs/concepts/**` | ROOT-SLIM |
| 6 | T-DOCS-GUIDES | `website/content/docs/guides/**` | ROOT-SLIM |
| 7 | T-DOCS-INTERNALS | `website/content/docs/internals/**` except `module-map.mdx` | ROOT-SLIM |
| 8 | T-DOCS-PROJECT | `website/content/docs/project/**`, `docs/research/**` (move out), `docs/archive/**` | ROOT-SLIM |
| 9 | T-DOCS-CI | `.github/workflows/docs.yml`, `.github/dependabot.yml` | ROOT-SLIM |
| 10 | T-DOCS-ROOT-SLIM | `README.md`, `USAGE.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/README.md`, `docs/usage.md`, `docs/guidelines.md`, `docs/execution-example.md`, `docs/fumadocs-plan.md` (delete), `website/generated/{contributing,changelog}.mdx` (regenerated) | AGENTS-MD |
| 11 | T-DOCS-AGENTS-MD | `AGENTS.md` | — |

T-DOCS-ROOT-SLIM additionally requires AC28 (Vercel production site live at the recorded `DOCS_URL`) before it merges, so stubs never link to a 404. The spec PR (this file) precedes T-DOCS-SCAFFOLD.

### 10.2 Concurrency
After SCAFFOLD merges, GEN, GETSTARTED, CONCEPTS, GUIDES and PROJECT run in parallel (disjoint scopes). After GEN, REFERENCE, INTERNALS and CI run in parallel. T-CODE-FIXES-AUDIT may run at any time.

### 10.3 Separate stream: T-CODE-FIXES-AUDIT
One ticket, one commit per item, each with a regression test. Items:
1. `agb sweep` drops `--project`.
2. MCP `agb_run.concurrency` is ignored.
3. MCP `serverInfo.version` reports `0.7.0` instead of root `package.json` `version`.
4. The usage banner and unknown-command messages print a literal `\n`.
5. The probe writer emits `probe-<day>.md` but committed files are `probes-*.md`; the `lib/pools.mjs:69` comment cites a nonexistent file.
6. Probe's default output directory is inside the plugin, not the user's repo or `AGB_CALIBRATION_DIR`.
7. The `AGB_ALLOW_DIRTY` warning says reset may run.
8. A test title in `test/security.test.mjs` says "on darwin" for a cross-platform test.
9. Find what writes a stray `undefined/` directory in the repo root during tests or runs (a path argument that was `undefined`); not reproduced at `4864376` — if it cannot be reproduced, document the search and close the item without a code change.

After the source edits: `npm run build`, commit `dist/`, and `git status --porcelain dist/ vendor/` must be empty. If `website/` exists on the branch's base, also run `cd website && npm run gen` and remove or rewrite each `Known issue (T-CODE-FIXES-AUDIT item N)` callout for fixed items. `lib/lock.mjs` and `lib/gates.mjs` are rails. Scope: `bin/**`, `mcp/**`, `sidecars/**`, `hooks/**`, `test/**`, `dist/**`, `CHANGELOG.md`, `website/generated/**`, `website/content/**`, and each `lib/` file other than `lock.mjs`/`gates.mjs`, enumerated.

---

## 11. Acceptance Criteria

Commands run from the repo root unless stated, with Node >= 22.19.0 on PATH. "Every docs PR" means every ticket in §10.1. Each AC names the ticket(s) where it is first enforced.

1. **Root suite passes offline** (every PR). `unshare -r -n npm test; echo $?` → `0` (Linux; network namespace with no interfaces).
2. **No site files in the tarball** (SCAFFOLD on). `node --test test/packaging.test.mjs; echo $?` → `0`.
3. **Docs PRs don't touch code or bundles** (every docs PR). `git diff --quiet origin/main -- lib bin mcp hooks sidecars scripts dist vendor; echo $?` → `0`.
4. **Exact pins** (SCAFFOLD on). `node -e "const p=require('./website/package.json');const d={...p.dependencies,...p.devDependencies};const bad=Object.entries(d).filter(([,v])=>!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v));console.log(bad.length);process.exit(bad.length)"` → `0`; and `jq -r '[.dependencies["fumadocs-core"],.dependencies["fumadocs-ui"],.dependencies["fumadocs-mdx"],.dependencies.next,.dependencies.react,.dependencies["react-dom"],.dependencies.mermaid,.dependencies["next-themes"],.devDependencies["next-validate-link"]]|join(" ")' website/package.json` → `16.17.1 16.17.1 15.4.7 16.4.0 19.3.0 19.3.0 12.1.0 0.4.6 1.6.7`.
5. **Installed React matches the pin** (SCAFFOLD on). `cd website && npm ci && node -p "require('react/package.json').version+' '+require('react-dom/package.json').version"` → `19.3.0 19.3.0`.
6. **Node floor** (SCAFFOLD on). `jq -r .engines.node package.json website/package.json` → `>=22.19.0` then `22.x`; `cat website/.nvmrc` → `22.19.0`.
7. **Server-output config** (SCAFFOLD on). `grep -cE "output:|basePath|trailingSlash|unoptimized|DOCS_BASE_PATH" website/next.config.mjs` → `0`; `test ! -e website/vercel.json && test ! -e website/public/.nojekyll && echo ok` → `ok`; `git check-ignore -q website/.next/x website/node_modules/x website/.source/x website/.vercel/x; echo $?` → `0`; `grep -c "takumi-js" website/README.md` → at least `1`.
8. **Server build** (SCAFFOLD on). `cd website && npm ci && npm run build && test -f .next/BUILD_ID && test ! -d out && echo ok` → `ok`.
9. **Running-site checks: links, search, llms.txt, OG, banner** (SCAFFOLD on; offline, localhost only). `cd website && npm run build && npm run check:site; echo $?` → `0`.
10. **Generated output fresh** (GEN on). `node website/scripts/gen-reference.mjs --check; echo $?` → `0`.
11. **Generator deterministic** (GEN on). `cd website && npm run gen && npm run gen && git diff --exit-code -- generated; echo $?` → `0`.
12. **Env drift gate** (GEN on). `node website/scripts/gen-reference.mjs --env-only --check; echo $?` → `0`; `node website/scripts/gen-reference.mjs --env-only --check --extra-token AGB_FAKE_UNDOCUMENTED 2>&1 | grep -c AGB_FAKE_UNDOCUMENTED` → at least `1` and that command (without the grep) exits `1`.
13. **IA structure** (SCAFFOLD on). `node website/scripts/check-ia.mjs; echo $?` → `0`.
14. **No placeholders left** (ROOT-SLIM). `node website/scripts/check-ia.mjs --no-placeholders; echo $?` → `0`.
15. **Stale patterns gone from the site** (every docs PR from GEN on). `node website/scripts/check-stale-claims.mjs; echo $?` → `0`.
16. **Stale patterns gone from root docs, every claim covered** (ROOT-SLIM). `node website/scripts/check-stale-claims.mjs --with-root --final; echo $?` → `0`.
17. **Evidence permalinks** (every docs PR from GEN on). `node website/scripts/check-evidence.mjs; echo $?` → `0`.
18. **Sidecar web-port auth bypass documented** (GEN on). `grep "ANTIGRAVITY_SIDECAR_WEB_PORT" website/generated/environment.mdx | grep -c "disables token auth"` → at least `1`.
19. **Stubs** (ROOT-SLIM). With `DOCS_URL` set to the D8 value: for each `f` in `USAGE.md ARCHITECTURE.md docs/guidelines.md docs/usage.md docs/execution-example.md docs/README.md`: `grep -qF "$DOCS_URL/docs/" $f`; `diff <(git show origin/main:$f | grep '^## ') <(grep '^## ' $f)` is empty; `grep -cE '^###|^\`\`\`' $f` → `0`; `wc -l < $f` ≤ `6 + 3 × $(grep -c '^## ' $f)`. A script loop printing any failure → no output.
20. **README slim** (ROOT-SLIM). `test $(wc -l < README.md) -le 120 && grep -qE '^#+ agb migrate$' README.md && grep -qF "$DOCS_URL" README.md && ! grep -q 'github.io/antigravity-booster' README.md && echo ok` → `ok`.
21. **Rails never intersect any scope** (before `ticket create --write`). For the ticket JSON files in the set, `node -e` script: union of all `rails` vs every `scope` entry, by `minimatch` both ways → prints `0` conflicts.
22. **Rails respected** (every PR). `npx adlc rails-guard --base origin/main --rails lib/lock.mjs --rails lib/gates.mjs --rails .adlc/config.json --rails CODEOWNERS; echo $?` → `0`.
23. **AGENTS.md only in its ticket** (every docs PR except AGENTS-MD). `git diff --quiet origin/main -- AGENTS.md; echo $?` → `0`.
24. **Design history** (PROJECT on). `test -d docs/archive/research && test ! -e docs/research && echo ok` → `ok`; AC9's `check:site` (f) covers the banner and (c) the search exclusion.
25. **Site test suite** (GEN on). `cd website && npm test; echo $?` → `0`.
26. **Workflow hardening, no deploy** (CI). `grep -E "uses: " .github/workflows/docs.yml | grep -vcE "@[0-9a-f]{40} # v"` → `0`; `grep -c "secrets\." .github/workflows/docs.yml` → `0`; `grep -cE "id-token|pages: write|deployments:|configure-pages|upload-pages-artifact|deploy-pages|environment:|vercel" .github/workflows/docs.yml` → `0`; `grep -c "contents: read" .github/workflows/docs.yml` → `3`.
27. **Other workflows untouched** (every docs PR). `git diff --quiet origin/main -- .github/workflows/ci.yml .github/workflows/adlc-rails-guard.yml .github/workflows/publish.yml .github/workflows/release-drift.yml; echo $?` → `0`; and for docs PRs other than T-DOCS-CI, `git diff --quiet origin/main -- .github; echo $?` → `0`.
28. **Vercel production live** (owner, after the §8.1 owner actions and a `main` deploy; gate for ROOT-SLIM merge). `DOCS_URL` is recorded in D8 and `grep -c '^DOCS_URL: https://' website/README.md` → `1`; `curl -so /dev/null -w '%{http_code}' "$DOCS_URL/docs"` → `200` (served by the required root `content/docs/index.mdx`, §4, which `check-site` (a) also checks at `/docs`).
29. **Config untouched** (every PR). `git diff --quiet origin/main -- .adlc/config.json; echo $?` → `0`.
30. **Gate evidence** (every PR). After AC1 and the ticket's own ACs pass in the same shell: `npm test && npx adlc gate-manifest record tests --ticket <id> && npx adlc gate-manifest verify; echo $?` → `0` (docs tickets with `website/` changes also record `docs-build` after `cd website && npm run build && npm run check:site`).
31. **Archive on merge** (after each merge's chore PR). `npx adlc ticket list --json | jq -e 'map(select(.id=="<id>"))|length==0' && ls .adlc/ticket-archive | grep -c "^$(echo <id> | tr A-Z a-z)--"` → `true` then `1`.
32. **Known issues track the code stream** (GEN on). `node website/scripts/check-known-issues.mjs; echo $?` → `0`.
33. **Vercel preview check on PRs** (owner-verified, from the first `website/` PR after the §8.1 owner actions). `gh pr checks <pr> | grep -ci vercel` → at least `1`, and that check's state is `pass`.
34. **Vercel project settings** (owner-verified, once). Owner attestation in a T-DOCS-CI PR comment, backed by screenshots of the Vercel project settings and the GitHub app's repository access page plus pasted build-log lines: Root Directory = `website/`; production branch = `main`; Ignored Build Step as in §8.1; the Vercel GitHub app is granted to this repository only; and the Node version line from the production build log shows `22.` (Vercel resolves it from `engines.node`). Mechanical evidence that production deploys succeed: `id=$(gh api 'repos/voodootikigod/antigravity-booster/deployments?environment=Production&per_page=1' --jq '.[0].id') && gh api "repos/voodootikigod/antigravity-booster/deployments/$id/statuses" --jq '[.[]|select(.state=="success")]|length'` → at least `1` (no `ref` filter: Vercel sets `ref` to the commit SHA). Root Directory, Node and the repo-only grant are attestation items, not proven by this query.

---

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Fumadocs/Next breaking releases during the stack | High | Build breaks | Exact pins (§3), committed lockfile, stop-and-ask on unavailable versions; grouped weekly Dependabot PR (§8) |
| Next/React security advisory on pinned versions | Medium | Vulnerable server runtime on Vercel (the site now runs server code: search, OG, llms routes) | Dependabot `/website` entry; upgrades are their own PRs; routes read only bundled content and take no user input beyond the search query |
| Static parse of `COMMANDS`/MCP array breaks on refactor | Medium | `gen-check` fails on the code PR | Parser negative fixtures (§7.12); generator contract in CONTRIBUTING (§7) |
| Generated docs block code PRs | Medium | Code PR red until regen | Cheap `gen-check` job, no `npm ci`; code PRs run `npm run gen` (contract §7); code stream has `website/generated/**` in scope; `docs.yml` not a required check |
| Rails deadlock between co-active tickets | Eliminated | — | Rails = 4 paths no ticket edits (§9, AC21) |
| Site documents unreleased `main` behavior | Medium | Users on 1.0.x confused | Version banner (D10, AC9 (e)) |
| Evidence links rot | Medium | Wrong line cited | Tag permalinks (D11), `check-evidence` |
| Env scan misses runtime-built names or flags non-env tokens | Medium | Undocumented var or noisy failure | `ignore` list with reasons, documented blind spot (§7.2) |
| Vercel outage or deploy failure | Low | Site unavailable or stale; content still readable in-repo as MDX | CI `build` + `check:site` independently prove the site builds; root stubs link to the site but the repo keeps `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `AGENTS.md` (D2); no plugin or CI dependency on Vercel |
| Third-party access via the Vercel GitHub app | Medium | Vercel can read the repo and post statuses/comments | Owner grants the app to this repository only (§8.1); no GitHub secrets or Vercel tokens in CI; the app is revocable without affecting CI; trust note in §8.1 |
| Preview URLs expose unreleased docs | Low | Unreleased behavior visible | Accepted: the repository is public (verified 2026-10-09), so previews reveal nothing new |
| Vercel build differs from CI build | Low | Preview/prod break while CI is green | Same Node major (`website/package.json` `engines.node` `22.x` pins Vercel to 22, which overrides the dashboard; CI uses `.nvmrc` `22.19.0`; the owner pastes the build-log Node line in AC34), committed lockfile with `npm ci`, no env vars; AC33 surfaces the Vercel check on every `website/` PR |
| `check-site` flakes (port in use, slow start) | Low | Spurious CI failure | Configurable `--port`, 60 s readiness poll, server killed in `finally` |
| Vercel builds every PR/push incl. code-only changes | Medium | Wasted build minutes; extra check on unrelated PRs | Ignored Build Step `git diff --quiet HEAD^ HEAD -- .` (§8.1); the Vercel check is never required |
| Vercel setup waits on the owner | Medium | Site not live | Owner checklist in T-DOCS-CI (§8); ROOT-SLIM gated on AC28 so stubs never 404 |
| Known-issue callouts outlive fixes | Medium | Drift | Code stream edits callouts; `check-known-issues` fails after its archive |
| Documenting `ANTIGRAVITY_SIDECAR_WEB_PORT` advertises an auth bypass | Low | Security | `reference/security.mdx` says: set only by the jetski launcher, binds locally, never set by hand; other pages link there |
| Optional-peer warnings read as breakage | Low | Confusion | `website/README.md` "Expected peer warnings" (AC7) |
| External deep links to root doc anchors break | Low | Friction | Stubs keep every H2 (AC19); README keeps `agb migrate` (AC20) |

---

## Appendix A. Finding → resolution

| Finding | Resolution |
|---|---|
| spec-lint AC20 no single verification | AC31 (single `jq -e` command) |
| AC1 offline unchecked | AC1 uses `unshare -r -n` |
| AC5 react-dom | AC4, AC5 cover both |
| AC7 search path hedge | Rev 3: §3.1 server route `/api/search`; `check-site` (c) queries it and validates content |
| AC11 undefined flags | §7 flag contract; AC12 |
| AC13 partial IA | `check-ia` against `ia.json`; `check-site` (a) |
| AC14 unmechanical / false matches | Per-claim patterns (§6) in `check-stale-claims`; design-history excluded by path; `npm pack --dry-run` no longer matches; generic count pattern |
| AC15 human judgment | AC18 two-grep pipeline |
| AC18 placeholder / output format | AC22 exact command, exit code |
| AC19 self-verifying | AC30 records only after the gate commands pass with `&&` |
| AC21 incomplete | AC26, AC27 |
| AC22 owner-only | AC28 marked owner gate for ROOT-SLIM |
| G1 search / banner unchecked | `check-site` (c), (f) |
| G2 untestable | Patterns + `claims:` + `check-evidence` + `--final` coverage |
| G4 secrets | AC26 |
| §3.1 config, .gitignore, dev | AC7; `dev` script contract §3.3 |
| §3 npm view / peer note | Stop-and-ask rule; AC7 |
| §4 meta.json | `check-ia` |
| §5 research move, probes note, anchor, README size | AC24; probes note dropped; AC20 |
| §7 env entries, bundledIgnored, gen content, drift test, test-only group | §7.2 rules + §7.12 tests; AC25 |
| §8 other workflows | AC27 |
| Known-issue callouts, follow-up PR | Core boundary 2, §10.3, `check-known-issues` |
| §10.2 ordering rule | Removed (no shared rails; probes note dropped) |
| Vague wording | Replaced: §4 page list defines coverage; check scripts define "fails loudly"; verify.mdx quotes fix text; security note text in §12; "proposal" removed; React pinned to 19.3.0 |
| Premortem 1 rails deadlock | §9 minimal rails, AC21 |
| Premortem 2 generated docs deadlock code PRs | Code stream scope includes `website/generated/**`; generator contract |
| Premortem 3 CI cost | `gen-check` without `npm ci`; build only on docs paths; npm cache |
| Premortem 4 docs track main | D10 banner |
| Premortem 5 link rot | D11, `check-evidence` |
| Premortem 6 generator blind spots | `ignore` list, scan roots exclude `website/`, parser negative fixtures |
| Premortem 7 basePath / includes | Rev 3: no basePath on Vercel; root-docs generator rewrites links; `check-site` (b) |
| Premortem 8 hosting not set up, stubs 404 | Owner checklist (§8, §8.1); CI precedes ROOT-SLIM; AC28 gate on Vercel production |
| Premortem 9 search | `check-site` (c), (d) |
| Premortem 10 packaging | `--ignore-scripts` already used; assertion in §8 |
| Premortem 11 AC regexes / stub budget | AC4 strict semver regex; §5.1 budget formula |
| Premortem 12 dependency rot | Dependabot (§8) |
| Premortem 13 stale callouts | `check-known-issues` |
| Premortem 14 ordering edge | No longer needed (§10.2) |
| Parallax A1, A2 | §9, §10.3 |
| Parallax A3 G5 | G5 reworded; probes note dropped; CHANGELOG in ROOT-SLIM scope |
| Parallax A4 pathspec | `gen-reference --check`; AC11 uses `-- generated` from `website/` |
| Parallax A5 path filters | `dist/**`, `vendor/**`, `docs.yml` added |
| Parallax A6 design history nav vs search | D9 |
| Parallax A7 stub length | §5.1 |
| Parallax A8 scaffold scope | SCAFFOLD owns all of `website/**` except GEN files and creates placeholders |
| Parallax A9 link order | Placeholders |
| Parallax A10 GEN size | T-DOCS-REFERENCE split out |
| Parallax A11 non-env tokens | `ignore` list |
| Parallax A12 rails table | Uniform rails (§9) |
| Parallax A13 "first PR" | §1 wording |
| Parallax A14, A15 AC coverage and per-PR timing | §6 patterns; AC "first enforced" labels |
| Parallax B (scaffolder) | §3.2 fallback; stop-and-ask; placement column; §3.3 scripts; §3.1 routes and search; `generated/` outside content |
| Parallax B (writer) | Generated filenames §7; root-docs link rewrite; callout format; bundledIgnored rule; design-history mapping §4; code wins over table §6; C12 wording; security note canonical in security.mdx |
| Rev 3 review: trailing slashes, Vercel Node via `engines`, AC34 `ref` filter, no Ignored Build Step, search index shape, OG `image.png` segment, `/docs` root 404, shallow `changes` checkout | §3.1 routes/search/OG; §3 Node row `22.x`; §7.11(a)(b) no redirects; §8 `changes` fetch-depth + fail-open; §8.1 owner action (4) + Vercel check never required; AC6, AC28, AC34; §12 rows |
| Owner decision 2026-10-09: Vercel instead of Pages | D1 (supersedes Pages), D6, D8, G4, N2, §3.1 server output, §3.2 flags re-verified, §7.11 `check-site`, §8 no deploy job, §8.1 owner actions/trust note/no `vercel.json`, AC7–AC9, AC19, AC20, AC26, AC28, AC33, AC34, §12 Vercel risks |
| Parallax B (CI) | Job-level concurrency; artifact only on push; §7.12 runner in `gen-check`; packaging test in root `npm test` with `--ignore-scripts`; no prebuild; cache settings; path list explicit; C28 count removed |
