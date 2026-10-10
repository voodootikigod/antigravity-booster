# antigravity-booster docs site

The documentation site for `antigravity-booster` (`agb`), built with [Fumadocs](https://fumadocs.dev) on Next.js and deployed on Vercel. The design is specified in [`.adlc/specs/docs-site.md`](../.adlc/specs/docs-site.md).

DOCS_URL: <to be recorded by the owner>

This directory is isolated from the shipped plugin: it has its own `package.json` and `package-lock.json`, is not an npm workspace, and is never part of the npm tarball. The root `npm test` does not depend on it.

## Develop

Use Node 22 (`.nvmrc` pins `22.19.0`).

```bash
cd website
npm ci
npm run dev          # http://localhost:3000
npm run build        # next build (server output)
npm run start        # serve the production build
```

No environment variable is needed at build or run time.

## Scripts

| Script | What it does |
|---|---|
| `dev` / `build` / `start` | `next dev` / `next build` / `next start` |
| `gen` | Regenerate the reference partials in `generated/` (`scripts/gen-reference.mjs`) |
| `check` | Offline content checks (`scripts/check-all.mjs`); sub-checks not yet present are skipped with a notice |
| `check:site` | Running-site checks against `next start` on `127.0.0.1` (needs a prior `npm run build`; `--port`, default `4310`) |
| `lint:links` | `next-validate-link` over `content/docs` |
| `lint` | Biome |
| `test` | `node --test scripts/test/` |

## Content

Pages live in `content/docs/`. Every folder has a `meta.json` whose `pages` array lists every page in order; `scripts/ia.json` holds the expected tree and `node scripts/check-ia.mjs` compares the two. Pages marked `placeholder: true` are waiting for their content ticket.

Design history (`content/docs/project/design-history/`) is listed in the navigation but excluded from search and from `llms.txt`.

## Expected peer warnings

`npm ci` can print optional-peer warnings for packages that this site intentionally does not install. They are expected and harmless:

- `takumi-js` (optional peer of `fumadocs-ui`): OG images use `ImageResponse` from `next/og` instead.
- `vite`, `rolldown`: alternative bundler integrations of `fumadocs-mdx`; this site uses Next.js.
- `satteri`: an alternative MDX processor preset of `fumadocs-mdx`; this site uses the default MDX pipeline.

## Deployment

- Deployed by the Vercel GitHub integration: production from `main`, a preview deployment per PR. There is no deploy job in GitHub Actions and no `vercel.json`.
- Vercel project settings (owner-operated): Root Directory `website/`; Node.js 22.x (Vercel resolves it from `engines.node` = `22.x` in `package.json`); default install and build commands.
- Ignored Build Step: `git diff --quiet HEAD^ HEAD -- .` (skips builds for commits that do not touch `website/`).
- The Vercel check is never a required status check; CI `build` + `check:site` is the merge evidence.
- No environment variables or secrets are configured on Vercel.
